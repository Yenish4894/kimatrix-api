import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { ConflictError, NotFoundError } from "@/errors/index";
import { AuditService } from "@/services/AuditService";
import { generateRandomToken } from "@/utils/crypto";
import { logger } from "@/utils/logger";
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
  /** When the company paused its own QR code. Null means live. */
  qrPausedAt: Date | null;
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
  private auditService = new AuditService();

  /**
   * Replaces the company's QR token, so a leaked or misprinted code stops working at
   * once: resolve and submit both look the company up by token, and the old one now
   * matches nothing (404).
   *
   * Allowed regardless of subscription state, like pausing: it grants nothing.
   */
  async regenerateQr(
    companyId: string,
    actor: { id: string; email: string },
  ): Promise<{ qrToken: string; qrUrl: string }> {
    // Same generator and length as registration and admin onboarding.
    const qrToken = generateRandomToken(24);

    await AppDataSource.transaction(async (manager) => {
      const [current] = (await manager.query(
        `SELECT "qr_token" FROM "companies" WHERE "id" = $1 FOR UPDATE`,
        [companyId],
      )) as { qr_token: string }[];
      if (!current) throw NotFoundError("Company not found");

      await manager.query(
        `UPDATE "companies" SET "qr_token" = $2, "updated_at" = now() WHERE "id" = $1`,
        [companyId, qrToken],
      );

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "company.qr_regenerate",
          entityType: "company",
          entityId: companyId,
          before: { qrToken: current.qr_token },
          after: { qrToken },
        },
        manager,
      );
    });

    logger.info({ companyId }, "QR code regenerated; the previous code no longer resolves");
    return { qrToken, qrUrl: this.buildQrUrl(qrToken) };
  }

  /**
   * Voids one of the company's purchases: the row stays, stamped with who, when and why,
   * and stops counting everywhere (customer totals, stats, reports, exports, lucky draw).
   *
   * One transaction, with the purchase row locked: two clicks cannot both decrement the
   * customer. Scoped by company in the lookup, so another company's id is a 404.
   */
  async voidPurchase(
    companyId: string,
    purchaseId: string,
    reason: string,
    actor: { id: string; email: string },
  ): Promise<Purchase> {
    const trimmed = reason.trim();
    return AppDataSource.transaction(async (manager) => {
      const row = await this.purchaseRepository.lockForVoid(purchaseId, companyId, manager);
      if (!row) throw NotFoundError("Purchase not found");
      if (row.voided_at != null) throw ConflictError("This purchase has already been voided.");

      await this.purchaseRepository.markVoided(purchaseId, trimmed, actor.id, manager);
      await this.customerRepository.subtractPurchase(
        row.customer_id,
        companyId,
        row.invoice_amount,
        manager,
      );

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "purchase.void",
          entityType: "purchase",
          entityId: purchaseId,
          before: {
            companyId,
            customerId: row.customer_id,
            invoiceNumber: row.invoice_number,
            invoiceAmount: row.invoice_amount,
          },
          after: { companyId, voided: true },
          note: trimmed,
        },
        manager,
      );

      const purchase = await this.purchaseRepository.findByIdInCompany(
        purchaseId,
        companyId,
        manager,
      );
      if (!purchase) throw NotFoundError("Purchase not found");
      logger.info({ companyId, purchaseId }, "Purchase voided");
      return purchase;
    });
  }

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
  /**
   * Turns QR submissions off or back on at the company's own request.
   *
   * Idempotent: pausing an already-paused code keeps the original timestamp rather
   * than resetting it, so "paused since" stays true across a double click or a retried
   * request. Resuming an already-live code is a no-op rather than an error, for the
   * same reason — a customer pressing a button twice is not a failure worth surfacing.
   *
   * Deliberately allowed regardless of subscription state. Pausing changes nothing a
   * lapsed company could otherwise do, and refusing would mean a business that stopped
   * paying could not take its own poster out of service.
   */
  async setQrPaused(companyId: string, paused: boolean): Promise<{ qrPausedAt: Date | null }> {
    const company = await this.companyRepository.findById(companyId);
    if (!company) throw NotFoundError("Company not found");

    if (paused && company.qrPausedAt != null) return { qrPausedAt: company.qrPausedAt };
    if (!paused && company.qrPausedAt == null) return { qrPausedAt: null };

    const qrPausedAt = paused ? new Date() : null;
    await this.companyRepository.setQrPaused(companyId, qrPausedAt);
    logger.info({ companyId, paused }, paused ? "QR submissions paused" : "QR submissions resumed");
    return { qrPausedAt };
  }

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
      qrPausedAt: company.qrPausedAt,
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
