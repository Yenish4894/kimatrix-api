import { config } from "@/config/index";
import { NotFoundError } from "@/errors/index";
import type { Company } from "@/entities/Company";
import type { Customer } from "@/entities/Customer";
import type { Purchase } from "@/entities/Purchase";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { CustomerRepository } from "@/repositories/CustomerRepository";
import type {
  CompanyCustomerStats,
  CustomerSortField,
  SortOrder,
} from "@/repositories/CustomerRepository";
import { PurchaseRepository } from "@/repositories/PurchaseRepository";
import type { PurchaseSortField } from "@/repositories/PurchaseRepository";
import type { UpdateProfileInput } from "@/validation/schemas/company.schema";

export interface CompanyProfile {
  id: string;
  name: string;
  streetAddress: string;
  city: string;
  state: string;
  country: string;
  postalCode: string | null;
  registrationNumber: string;
  contactEmail: string;
  contactPhone: string;
  whatsappNumber: string | null;
  businessType: Company["businessType"];
  promoEmailOptIn: boolean;
  isActive: boolean;
  joinedAt: Date;
  qrToken: string;
  qrUrl: string;
}

export interface ListCustomersQuery {
  page: number;
  limit: number;
  search?: string;
  sortBy?: CustomerSortField;
  sortOrder?: SortOrder;
}

export interface ListPurchasesQuery {
  page: number;
  limit: number;
  search?: string;
  customerId?: string;
  from?: Date;
  to?: Date;
  sortBy?: PurchaseSortField;
  sortOrder?: SortOrder;
}

export class CompanyService {
  private companyRepository = new CompanyRepository();
  private customerRepository = new CustomerRepository();
  private purchaseRepository = new PurchaseRepository();

  async updateProfile(companyId: string, input: UpdateProfileInput): Promise<CompanyProfile> {
    const updates: Parameters<CompanyRepository["updateProfile"]>[1] = {};
    if (input.streetAddress !== undefined) updates.streetAddress = input.streetAddress;
    if (input.city !== undefined) updates.city = input.city;
    if (input.state !== undefined) updates.state = input.state;
    if (input.country !== undefined) updates.country = input.country;
    if (input.postalCode !== undefined) updates.postalCode = input.postalCode || null;
    if (input.contactEmail !== undefined) updates.contactEmail = input.contactEmail;
    if (input.contactPhone !== undefined) updates.contactPhone = input.contactPhone;
    if (input.whatsappNumber !== undefined) updates.whatsappNumber = input.whatsappNumber || null;
    if (input.promoEmailOptIn !== undefined) updates.promoEmailOptIn = input.promoEmailOptIn;

    await this.companyRepository.updateProfile(companyId, updates);
    const updated = await this.companyRepository.findById(companyId);
    if (!updated) throw new Error("Company not found after update");
    return this.getProfile(updated);
  }

  getProfile(company: Company): CompanyProfile {
    return {
      id: company.id,
      name: company.name,
      streetAddress: company.streetAddress,
      city: company.city,
      state: company.state,
      country: company.country,
      postalCode: company.postalCode,
      registrationNumber: company.registrationNumber,
      contactEmail: company.contactEmail,
      contactPhone: company.contactPhone,
      whatsappNumber: company.whatsappNumber,
      businessType: company.businessType,
      promoEmailOptIn: company.promoEmailOptIn,
      isActive: company.isActive,
      joinedAt: company.joinedAt,
      qrToken: company.qrToken,
      qrUrl: this.buildQrUrl(company.qrToken),
    };
  }

  async getStats(companyId: string): Promise<CompanyCustomerStats> {
    return this.customerRepository.getCompanyStats(companyId);
  }

  async listCustomers(
    companyId: string,
    query: ListCustomersQuery,
  ): Promise<{ items: Customer[]; total: number }> {
    return this.customerRepository.listByCompany({
      companyId,
      page: query.page,
      limit: query.limit,
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.sortOrder !== undefined ? { sortOrder: query.sortOrder } : {}),
    });
  }

  async getCustomer(companyId: string, customerId: string): Promise<Customer> {
    const customer = await this.customerRepository.findByIdInCompany(customerId, companyId);
    if (!customer) {
      throw NotFoundError("Customer not found");
    }
    return customer;
  }

  async listPurchases(
    companyId: string,
    query: ListPurchasesQuery,
  ): Promise<{ items: Purchase[]; total: number }> {
    return this.purchaseRepository.listByCompany({
      companyId,
      page: query.page,
      limit: query.limit,
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.customerId !== undefined ? { customerId: query.customerId } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
      ...(query.sortBy !== undefined ? { sortBy: query.sortBy } : {}),
      ...(query.sortOrder !== undefined ? { sortOrder: query.sortOrder } : {}),
    });
  }

  async getPurchase(companyId: string, purchaseId: string): Promise<Purchase> {
    const purchase = await this.purchaseRepository.findByIdInCompany(purchaseId, companyId);
    if (!purchase) {
      throw NotFoundError("Purchase not found");
    }
    return purchase;
  }

  async exportCustomersCsv(companyId: string): Promise<string> {
    const customers = await this.customerRepository.exportByCompany(companyId);
    const header = [
      "Full Name",
      "Mobile",
      "Vehicle Number",
      "Total Spend",
      "Submission Count",
      "First Submission",
      "Last Submission",
    ];
    const rows = customers.map((c) => [
      c.fullName,
      c.mobile,
      c.vehicleNumber ?? "",
      c.totalInvoiceAmount,
      String(c.submissionCount),
      c.firstSubmissionAt.toISOString(),
      c.lastSubmissionAt.toISOString(),
    ]);
    return this.buildCsv([header, ...rows]);
  }

  async exportPurchasesCsv(companyId: string): Promise<string> {
    const purchases = await this.purchaseRepository.exportByCompany(companyId);
    const header = [
      "Invoice Number",
      "Amount",
      "Full Name",
      "Vehicle Number",
      "Mobile",
      "Submitted At",
    ];
    const rows = purchases.map((p) => [
      p.invoiceNumber,
      p.invoiceAmount,
      p.fullNameSnapshot,
      p.vehicleNumberSnapshot ?? "",
      p.customer?.mobile ?? "",
      p.submittedAt.toISOString(),
    ]);
    return this.buildCsv([header, ...rows]);
  }

  private buildCsv(rows: string[][]): string {
    return rows
      .map((cols) => cols.map((v) => `"${v.replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
  }

  private buildQrUrl(qrToken: string): string {
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    return `${base}/qr/${qrToken}`;
  }
}
