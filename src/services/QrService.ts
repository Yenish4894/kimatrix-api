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
  /** Drives the currency symbol on the customer form. */
  country: string;
}

export interface SubmitPurchaseContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface SubmitPurchaseResult {
  purchaseId: string;
  customerId: string;
  customerTotalInvoiceAmount: string;
  customerSubmissionCount: number;
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
      isAcceptingSubmissions: computeEntitlement(company, new Date()).hasAccess,
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
        customer = existingCustomer;
        await manager
          .getRepository(Customer)
          .update({ id: customer.id }, { fullName, vehicleNumber });
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

      const updated = await this.customerRepository.findByIdInCompany(
        customer.id,
        company.id,
        manager,
      );

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
        customerTotalInvoiceAmount: updated?.totalInvoiceAmount ?? purchase.invoiceAmount,
        customerSubmissionCount: updated?.submissionCount ?? 1,
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
