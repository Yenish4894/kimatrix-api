import { AppDataSource } from "data-source";
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
import type { SubmitPurchaseInput } from "@/validation/schemas/qr.schema";

export interface QrResolveResult {
  companyId: string;
  companyName: string;
  businessType: Company["businessType"];
  isActive: boolean;
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
    return {
      companyId: company.id,
      companyName: company.name,
      businessType: company.businessType,
      isActive: company.isActive,
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
      if (!company.isActive) {
        throw BadRequestError("This company is not currently accepting submissions");
      }
      if (company.subscriptionExpiresAt && company.subscriptionExpiresAt < new Date()) {
        throw BadRequestError("This company is not currently accepting submissions");
      }

      this.assertBusinessTypeFields(company.businessType, input);

      const mobile = input.mobile.trim();
      const fullName = input.fullName.trim();
      const vehicleNumber = input.vehicleNumber?.trim().toUpperCase() ?? null;
      const invoiceNumber = input.invoiceNumber.trim();

      await this.assertResubmitCooldown(company.id, mobile);

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

  private async assertResubmitCooldown(companyId: string, mobile: string): Promise<void> {
    const intervalMinutes = config.QR_MIN_RESUBMIT_INTERVAL_MIN;
    if (intervalMinutes <= 0) return;
    const intervalMs = intervalMinutes * 60_000;

    const recent = await this.customerRepository.findMostRecentByCompanyAndMobile(
      companyId,
      mobile,
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
