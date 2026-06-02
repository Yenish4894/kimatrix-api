import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { Customer } from "@/entities/Customer";

export type CustomerSortField =
  | "totalInvoiceAmount"
  | "submissionCount"
  | "lastSubmissionAt"
  | "firstSubmissionAt";

export type SortOrder = "ASC" | "DESC";

export interface ListCustomersOptions {
  companyId: string;
  page: number;
  limit: number;
  search?: string;
  sortBy?: CustomerSortField;
  sortOrder?: SortOrder;
}

export interface CompanyCustomerStats {
  totalCustomers: number;
  totalPurchases: number;
  totalSpend: string;
  topSpender: {
    id: string;
    fullName: string;
    mobile: string;
    vehicleNumber: string | null;
    totalInvoiceAmount: string;
    submissionCount: number;
  } | null;
}

export class CustomerRepository {
  private getRepo(manager?: EntityManager): Repository<Customer> {
    return manager ? manager.getRepository(Customer) : AppDataSource.getRepository(Customer);
  }

  async findByIdInCompany(
    customerId: string,
    companyId: string,
    manager?: EntityManager,
  ): Promise<Customer | null> {
    return this.getRepo(manager)
      .createQueryBuilder("c")
      .where("c.id = :customerId", { customerId })
      .andWhere("c.company_id = :companyId", { companyId })
      .getOne();
  }

  async findByCompanyAndMobile(
    companyId: string,
    mobile: string,
    vehicleNumber: string | null,
    manager?: EntityManager,
  ): Promise<Customer | null> {
    const qb = this.getRepo(manager)
      .createQueryBuilder("c")
      .where("c.company_id = :companyId", { companyId })
      .andWhere("c.mobile = :mobile", { mobile });

    if (vehicleNumber === null) {
      qb.andWhere("c.vehicle_number IS NULL");
    } else {
      qb.andWhere("c.vehicle_number = :vehicleNumber", { vehicleNumber });
    }
    return qb.getOne();
  }

  async listByCompany(
    opts: ListCustomersOptions,
    manager?: EntityManager,
  ): Promise<{ items: Customer[]; total: number }> {
    const { companyId, page, limit, search, sortBy, sortOrder } = opts;
    const qb = this.getRepo(manager)
      .createQueryBuilder("c")
      .where("c.company_id = :companyId", { companyId });

    if (search && search.trim() !== "") {
      qb.andWhere(
        "(c.mobile ILIKE :search OR c.full_name ILIKE :search OR c.vehicle_number ILIKE :search)",
        { search: `%${search.trim()}%` },
      );
    }

    const sortColumnMap: Record<CustomerSortField, string> = {
      totalInvoiceAmount: "c.totalInvoiceAmount",
      submissionCount: "c.submissionCount",
      lastSubmissionAt: "c.lastSubmissionAt",
      firstSubmissionAt: "c.firstSubmissionAt",
    };
    const sortColumn = sortColumnMap[sortBy ?? "totalInvoiceAmount"];
    const direction: SortOrder = sortOrder === "ASC" ? "ASC" : "DESC";

    qb.orderBy(sortColumn, direction)
      .addOrderBy("c.id", "ASC")
      .take(limit)
      .skip((page - 1) * limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async findMostRecentByCompanyAndMobile(
    companyId: string,
    mobile: string,
    manager?: EntityManager,
  ): Promise<Customer | null> {
    return this.getRepo(manager)
      .createQueryBuilder("c")
      .where("c.company_id = :companyId", { companyId })
      .andWhere("c.mobile = :mobile", { mobile })
      .orderBy("c.lastSubmissionAt", "DESC")
      .limit(1)
      .getOne();
  }

  async exportByCompany(companyId: string, manager?: EntityManager): Promise<Customer[]> {
    return this.getRepo(manager)
      .createQueryBuilder("c")
      .where("c.company_id = :companyId", { companyId })
      .orderBy("c.totalInvoiceAmount", "DESC")
      .addOrderBy("c.id", "ASC")
      .getMany();
  }

  async getCompanyStats(companyId: string, manager?: EntityManager): Promise<CompanyCustomerStats> {
    const repo = this.getRepo(manager);

    const raw = await repo
      .createQueryBuilder("c")
      .select("COUNT(c.id)", "total_customers")
      .addSelect("COALESCE(SUM(c.total_invoice_amount), 0)", "total_spend")
      .addSelect("COALESCE(SUM(c.submission_count), 0)", "total_purchases")
      .where("c.company_id = :companyId", { companyId })
      .getRawOne<{
        total_customers: string;
        total_spend: string;
        total_purchases: string;
      }>();

    const topSpender = await repo
      .createQueryBuilder("c")
      .where("c.company_id = :companyId", { companyId })
      .orderBy("c.totalInvoiceAmount", "DESC")
      .addOrderBy("c.id", "ASC")
      .limit(1)
      .getOne();

    return {
      totalCustomers: Number(raw?.total_customers ?? 0),
      totalPurchases: Number(raw?.total_purchases ?? 0),
      totalSpend: raw?.total_spend ?? "0",
      topSpender: topSpender
        ? {
            id: topSpender.id,
            fullName: topSpender.fullName,
            mobile: topSpender.mobile,
            vehicleNumber: topSpender.vehicleNumber,
            totalInvoiceAmount: topSpender.totalInvoiceAmount,
            submissionCount: topSpender.submissionCount,
          }
        : null,
    };
  }

  async create(data: Partial<Customer>, manager?: EntityManager): Promise<Customer> {
    const repo = this.getRepo(manager);
    return repo.save(repo.create(data));
  }

  async getPlatformAggregates(
    manager?: EntityManager,
  ): Promise<{ totalCustomers: number; totalPurchases: number; totalSpend: string }> {
    const raw = await this.getRepo(manager)
      .createQueryBuilder("c")
      .select("COUNT(c.id)", "total_customers")
      .addSelect("COALESCE(SUM(c.submission_count), 0)", "total_purchases")
      .addSelect("COALESCE(SUM(c.total_invoice_amount), 0)", "total_spend")
      .getRawOne<{
        total_customers: string;
        total_purchases: string;
        total_spend: string;
      }>();

    return {
      totalCustomers: Number(raw?.total_customers ?? 0),
      totalPurchases: Number(raw?.total_purchases ?? 0),
      totalSpend: raw?.total_spend ?? "0",
    };
  }
}
