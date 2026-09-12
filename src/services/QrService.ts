import { AppDataSource } from "data-source";
import type { EntityManager } from "typeorm";
import { config } from "@/config/index";
import type { Company } from "@/entities/Company";
import { Customer } from "@/entities/Customer";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { CustomerRepository } from "@/repositories/CustomerRepository";
import { PurchaseRepository } from "@/repositories/PurchaseRepository";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from "@/errors/index";
import { logger } from "@/utils/logger";
import { computeEntitlement } from "@/utils/entitlement";
import type { SubmitPurchaseInput } from "@/validation/schemas/qr.schema";

export interface QrResolveResult {
  companyId: string;
  companyName: string;
  businessType: Company["businessType"];
  /**
   * Whether a submission would actually be accepted right now. Replaces the old raw
   * `isActive`, which ignored expiry — so the scan page rendered a working form and
   * the customer only discovered the problem after filling it in and pressing submit.
   */
  isAcceptingSubmissions: boolean;
  /**
   * True only when the company itself paused submissions.
   *
   * Kept separate from `isAcceptingSubmissions` so the scan page can say "this
   * business has paused entries, check back soon" rather than the vague wording used
   * when the reason is billing. Safe to disclose — a shop choosing to pause is not
   * confidential, whereas a lapsed subscription is, and this endpoint is public and
   * unauthenticated.
   */
  pausedByCompany: boolean;
  /** Drives the currency symbol on the customer form. */
  country: string;
}

export interface SubmitPurchaseContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

/**
 * Deliberately carries no customer totals: the caller is anonymous, and echoing a
 * customer's lifetime spend and visit count let anyone who knew a mobile number read
 * them.
 */
export interface SubmitPurchaseResult {
  purchaseId: string;
  customerId: string;
  submittedAt: Date;
}

export class QrService {
  private companyRepository = new CompanyRepository();
  private customerRepository = new CustomerRepository();
  private purchaseRepository = new PurchaseRepository();

  async resolveByToken(qrToken: string): Promise<QrResolveResult> {
    const company = await this.companyRepository.findByQrToken(qrToken);
    if (!company) {
      throw NotFoundError("QR code not recognized");
    }
    // Deliberately returns 200 with a flag rather than an error: the page renders a
    // branded "not accepting submissions" state. The reason is never disclosed —
    // this endpoint is public and unauthenticated.
    return {
      companyId: company.id,
      companyName: company.name,
      businessType: company.businessType,
      // Both must hold: the platform must be willing to serve them, and they must
      // not have paused themselves.
      isAcceptingSubmissions:
        computeEntitlement(company, new Date()).hasAccess && company.qrPausedAt == null,
      pausedByCompany: company.qrPausedAt != null,
      country: company.country,
    };
  }

  async submitPurchase(
    qrToken: string,
    input: SubmitPurchaseInput,
    context: SubmitPurchaseContext,
  ): Promise<SubmitPurchaseResult> {
    return AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findByQrToken(qrToken, manager);
      if (!company) {
        throw NotFoundError("QR code not recognized");
      }
      // Checked before entitlement so a paused shop gets the accurate message rather
      // than one implying a billing problem. Enforced here and not only on the resolve
      // endpoint: the form is a public page anyone can POST to directly, and a
      // customer who loaded it moments before the pause would otherwise still submit.
      if (company.qrPausedAt != null) {
        throw BadRequestError(
          "This business has paused new entries for now. Please check back soon.",
        );
      }
      if (!computeEntitlement(company, new Date()).hasAccess) {
        throw BadRequestError("This company is not currently accepting submissions");
      }

      this.assertBusinessTypeFields(company.businessType, input);

      const mobile = input.mobile.trim();
      const fullName = input.fullName.trim();
      const vehicleNumber = input.vehicleNumber?.trim().toUpperCase() ?? null;
      const invoiceNumber = input.invoiceNumber.trim();

      await this.assertResubmitCooldown(company.id, mobile, manager);

      const invoiceExists = await this.purchaseRepository.findByCompanyAndInvoice(
        company.id,
        invoiceNumber,
        manager,
      );
      if (invoiceExists) {
        throw ConflictError("This invoice number has already been submitted");
      }

      const existingCustomer = await this.customerRepository.findByCompanyAndMobile(
        company.id,
        mobile,
        vehicleNumber,
        manager,
      );

      const now = new Date();
      const invoiceAmountString = input.invoiceAmount.toFixed(2);
      let customer: Customer;

      if (existingCustomer) {
        // The stored name and vehicle are NOT overwritten. This endpoint is public and
        // unauthenticated, so letting a submission rewrite them let anyone who knew a
        // mobile number rename that customer in the merchant's records. What was typed
        // this time is still kept on the purchase as its name/vehicle snapshot.
        customer = existingCustomer;
      } else {
        customer = await this.customerRepository.create(
          {
            company,
            mobile,
            fullName,
            vehicleNumber,
            totalInvoiceAmount: "0",
            submissionCount: 0,
            firstSubmissionAt: now,
            lastSubmissionAt: now,
          },
          manager,
        );
      }

      const purchase = await this.purchaseRepository.create(
        {
          company,
          customer,
          invoiceNumber,
          invoiceAmount: invoiceAmountString,
          fullNameSnapshot: fullName,
          vehicleNumberSnapshot: vehicleNumber,
          submittedAt: now,
          ipAddress: context.ip ?? null,
          userAgent: context.userAgent ?? null,
          latitude: input.latitude !== undefined ? input.latitude.toString() : null,
          longitude: input.longitude !== undefined ? input.longitude.toString() : null,
          locationAccuracy:
            input.locationAccuracy !== undefined ? input.locationAccuracy.toString() : null,
        },
        manager,
      );

      await manager
        .createQueryBuilder()
        .update(Customer)
        .set({
          totalInvoiceAmount: () => `total_invoice_amount + :amount`,
          submissionCount: () => `submission_count + 1`,
          lastSubmissionAt: now,
        })
        .where("id = :id", { id: customer.id })
        .setParameters({ amount: invoiceAmountString })
        .execute();

      logger.info(
        {
          companyId: company.id,
          customerId: customer.id,
          purchaseId: purchase.id,
          invoiceNumber,
        },
        "Purchase submitted",
      );

      return {
        purchaseId: purchase.id,
        customerId: customer.id,
        submittedAt: purchase.submittedAt,
      };
    });
  }

  /**
   * @param manager REQUIRED. This runs inside `submitPurchase`'s transaction, and
   * omitting it took a SECOND connection from the pool for the same request. With
   * `max: 10`, ten simultaneous scans held all ten inside their transactions and then
   * each waited for an eleventh that could never arrive — every one timing out after
   * 5s and starving the rest of the app alongside them. Ten concurrent scans is one
   * busy forecourt, not a load test.
   *
   * It also makes the cooldown read consistent with the write it guards, which it
   * previously wasn't.
   */
  private async assertResubmitCooldown(
    companyId: string,
    mobile: string,
    manager: EntityManager,
  ): Promise<void> {
    const intervalMinutes = config.QR_MIN_RESUBMIT_INTERVAL_MIN;
    if (intervalMinutes <= 0) return;
    const intervalMs = intervalMinutes * 60_000;

    const recent = await this.customerRepository.findMostRecentByCompanyAndMobile(
      companyId,
      mobile,
      manager,
    );
    if (!recent) return;

    const elapsedMs = Date.now() - recent.lastSubmissionAt.getTime();
    if (elapsedMs >= intervalMs) return;

    const remainingMinutes = Math.max(1, Math.ceil((intervalMs - elapsedMs) / 60_000));
    const minutesLabel = remainingMinutes === 1 ? "minute" : "minutes";
    throw TooManyRequestsError(
      `You've already submitted a receipt at this business recently. Please wait about ${remainingMinutes} more ${minutesLabel} before submitting another one.`,
    );
  }

  private assertBusinessTypeFields(
    businessType: Company["businessType"],
    input: SubmitPurchaseInput,
  ): void {
    if (businessType === "fuel_station" && !input.vehicleNumber) {
      throw BadRequestError("Vehicle number is required for fuel station submissions");
    }
    if (businessType === "shop" && input.vehicleNumber) {
      throw BadRequestError("Vehicle number is not allowed for shop submissions");
    }
  }
}
