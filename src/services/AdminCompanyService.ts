import { AppDataSource } from "data-source";
import type { Company } from "@/entities/Company";
import type { Customer } from "@/entities/Customer";
import type { Purchase } from "@/entities/Purchase";
import {
  CompanyRepository,
  type CompanyBusinessTypeFilter,
  type CompanyStatusFilter,
  type PlatformStats,
} from "@/repositories/CompanyRepository";
import { CustomerRepository } from "@/repositories/CustomerRepository";
import { LuckyDrawRepository, type DrawHistoryRow } from "@/repositories/LuckyDrawRepository";
import { PurchaseRepository } from "@/repositories/PurchaseRepository";
import { requireCompany } from "@/services/adminCompanyLookup";
import type {
  ListCustomersQueryInput,
  ListPurchasesQueryInput,
} from "@/validation/schemas/company.schema";

/** A company as the admin endpoints return it. `createdByAdmin` is a frontend contract. */
export type AdminCompany = Company & {
  /** True iff an admin onboarded it (a `company.create` audit row exists). */
  createdByAdmin: boolean;
};

export interface ListCompaniesInput {
  page: number;
  limit: number;
  search?: string;
  status?: CompanyStatusFilter;
  businessType?: CompanyBusinessTypeFilter;
}

export interface PlatformStatsResult extends PlatformStats {
  totalCustomers: number;
  totalPurchases: number;
  totalSpend: string;
  /** Spend per company country; amounts are in that country's currency. */
  spendByCountry: { country: string; total: string }[];
}

/**
 * Read-only admin views of companies: the list, the detail page, its customers,
 * purchases and draws, and the platform totals on the dashboard.
 */
export class AdminCompanyService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly customerRepository = new CustomerRepository(),
    private readonly purchaseRepository = new PurchaseRepository(),
    private readonly luckyDrawRepository = new LuckyDrawRepository(),
  ) {}

  /**
   * `createdByAdmin` on every row: the admin UI offers "Resend invite" only for these.
   * Resolved for the whole page in one query (see CompanyRepository.adminCreatedIds).
   */
  async listCompanies(
    input: ListCompaniesInput,
  ): Promise<{ items: AdminCompany[]; total: number }> {
    const { items, total } = await this.companyRepository.listForAdmin(input);
    const adminCreated = await this.companyRepository.adminCreatedIds(items.map((c) => c.id));
    return {
      items: items.map((c) => Object.assign(c, { createdByAdmin: adminCreated.has(c.id) })),
      total,
    };
  }

  /** The detail endpoint's company, with the same `createdByAdmin` flag as the list. */
  async getCompany(companyId: string): Promise<AdminCompany> {
    const company = await requireCompany(this.companyRepository, companyId);
    const adminCreated = await this.companyRepository.adminCreatedIds([companyId]);
    return Object.assign(company, { createdByAdmin: adminCreated.has(companyId) });
  }

  /** Same repository call and item shape as GET /api/company/customers. */
  async listCompanyCustomers(
    companyId: string,
    q: ListCustomersQueryInput,
  ): Promise<{ items: Customer[]; total: number }> {
    await requireCompany(this.companyRepository, companyId);
    return this.customerRepository.listByCompany({
      companyId,
      page: q.page,
      limit: q.limit,
      ...(q.search !== undefined ? { search: q.search } : {}),
      ...(q.sortBy !== undefined ? { sortBy: q.sortBy } : {}),
      ...(q.sortOrder !== undefined ? { sortOrder: q.sortOrder } : {}),
    });
  }

  /** Same repository call and item shape as GET /api/company/purchases (voided rows included, flagged). */
  async listCompanyPurchases(
    companyId: string,
    q: ListPurchasesQueryInput,
  ): Promise<{ items: Purchase[]; total: number }> {
    await requireCompany(this.companyRepository, companyId);
    return this.purchaseRepository.listByCompany({
      companyId,
      page: q.page,
      limit: q.limit,
      ...(q.search !== undefined ? { search: q.search } : {}),
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.sortBy !== undefined ? { sortBy: q.sortBy } : {}),
      ...(q.sortOrder !== undefined ? { sortOrder: q.sortOrder } : {}),
    });
  }

  /** Same rows as the history in GET /api/company/draws. */
  async getCompanyDraws(companyId: string): Promise<{ history: DrawHistoryRow[] }> {
    await requireCompany(this.companyRepository, companyId);
    return {
      history: await this.luckyDrawRepository.history(companyId, AppDataSource.manager),
    };
  }

  async getPlatformStats(): Promise<PlatformStatsResult> {
    const [companyStats, aggregates] = await Promise.all([
      this.companyRepository.getPlatformStats(),
      this.customerRepository.getPlatformAggregates(),
    ]);
    return { ...companyStats, ...aggregates };
  }
}
