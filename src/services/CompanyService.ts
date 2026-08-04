import { config } from "@/config/index";
import { NotFoundError } from "@/errors/index";
import type { Company, SubscriptionStatus } from "@/entities/Company";
import { computeEntitlement } from "@/utils/entitlement";
import type { Customer } from "@/entities/Customer";
import type { Purchase } from "@/entities/Purchase";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { CustomerRepository } from "@/repositories/CustomerRepository";
import type {
  CompanyCustomerStats,
  CustomerSortField,
  SortOrder,
} from "@/repositories/CustomerRepository";
import { PurchaseRepository, type MonthlyTotals } from "@/repositories/PurchaseRepository";
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
  subscriptionExpiresAt: Date | null;

  // ── Entitlement, computed server-side ──
  /**
   * The frontend gate reads THIS and nothing else. It must never re-derive access
   * from a date: the old client-side `expiresAt > Date.now()` disagreed with the
   * backend about what a null expiry meant, and was vulnerable to client clock skew.
   */
  hasAccess: boolean;
  subscriptionStatus: SubscriptionStatus;
  /** Unified end-of-access across trial, paid and comp. `null` = perpetual or never started. */
  accessUntil: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  isTrial: boolean;
  isComped: boolean;
  canExport: boolean;
  /**
   * Owner's email confirmation state. Lives on `users`, surfaced here because the
   * dashboard needs it for the "confirm your email" banner and, from Phase 3, to
   * explain why a trial hasn't started yet.
   */
  emailVerified: boolean;

  currentPlan: {
    id: string;
    name: string;
    durationDays: number;
    price: string;
    currency: string;
  } | null;
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

export interface MonthlyReport {
  from: Date;
  to: Date;
  totals: MonthlyTotals;
  topCustomers: {
    customerId: string;
    fullName: string;
    mobile: string;
    vehicleNumber: string | null;
    /** String, not number — numeric(14,2) through a float loses cents. */
    totalSpend: string;
    purchaseCount: number;
    lastActivity: Date;
  }[];
}

export class CompanyService {
  private companyRepository = new CompanyRepository();
  private customerRepository = new CustomerRepository();
  private purchaseRepository = new PurchaseRepository();

  async updateProfile(
    companyId: string,
    input: UpdateProfileInput,
    emailVerifiedAt?: Date | null,
  ): Promise<CompanyProfile> {
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
    return this.getProfile(updated, emailVerifiedAt);
  }

  /**
   * `emailVerifiedAt` is passed in rather than read off `company.owner` because
   * `findByOwnerUserId` does not join the owner relation — the caller already has
   * the authenticated user on the request.
   */
  getProfile(company: Company, emailVerifiedAt?: Date | null): CompanyProfile {
    const entitlement = computeEntitlement(company, new Date());
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
      subscriptionExpiresAt: company.subscriptionExpiresAt,
      hasAccess: entitlement.hasAccess,
      subscriptionStatus: entitlement.status,
      accessUntil: entitlement.endsAt,
      // Both ends of the trial window, because the dashboard progress bar needs the
      // SPAN to be honest. With only the end date it has to guess a denominator, and
      // the guess it made — the paid plan's duration, defaulting to 30 — drew day one
      // of a 7-day trial as a nearly-spent bar.
      trialStartedAt: company.trialStartedAt,
      trialEndsAt: company.trialEndsAt,
      isTrial: entitlement.isTrial,
      isComped: company.isComped,
      canExport: entitlement.canExport,
      emailVerified: (emailVerifiedAt ?? company.owner?.emailVerifiedAt ?? null) != null,
      currentPlan: company.currentPlan
        ? {
            id: company.currentPlan.id,
            name: company.currentPlan.name,
            durationDays: company.currentPlan.durationDays,
            price: company.currentPlan.price,
            currency: company.currentPlan.currency,
          }
        : null,
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

  private buildQrUrl(qrToken: string): string {
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    return `${base}/qr/${qrToken}`;
  }

  /**
   * Monthly report for one calendar month, aggregated in the database.
   *
   * The month window is built as [first of month, first of next month) — a half-open
   * range, not `BETWEEN`. `BETWEEN` on a timestamp includes the upper bound, so a
   * purchase landing exactly at midnight on the 1st would be counted in both months.
   */
  async getMonthlyReport(companyId: string, year: number, month: number): Promise<MonthlyReport> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const { totals, topCustomers } = await this.purchaseRepository.getMonthlyReport({
      companyId,
      from,
      to,
    });

    return {
      from,
      to,
      totals,
      topCustomers: topCustomers.map((r) => ({
        customerId: r.customer_id,
        fullName: r.full_name,
        mobile: r.mobile,
        vehicleNumber: r.vehicle_number,
        totalSpend: r.total_spend,
        purchaseCount: r.purchase_count,
        lastActivity: r.last_activity,
      })),
    };
  }
}
