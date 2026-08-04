import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { Purchase } from "@/entities/Purchase";

export type PurchaseSortField = "submittedAt" | "invoiceAmount";

export type SortOrder = "ASC" | "DESC";

export interface ListPurchasesOptions {
  companyId: string;
  page: number;
  limit: number;
  search?: string;
  customerId?: string;
  from?: Date;
  to?: Date;
  sortBy?: PurchaseSortField;
  sortOrder?: SortOrder;
}

export interface MonthlyTotals {
  purchaseCount: number;
  /** Kept as a string: numeric(14,2) through JS floats loses cents at scale. */
  totalAmount: string;
  uniqueCustomers: number;
}

export interface TopCustomerRow {
  customer_id: string;
  full_name: string;
  vehicle_number: string | null;
  mobile: string;
  total_spend: string;
  purchase_count: number;
  last_activity: Date;
}

export class PurchaseRepository {
  private getRepo(manager?: EntityManager): Repository<Purchase> {
    return manager ? manager.getRepository(Purchase) : AppDataSource.getRepository(Purchase);
  }

  async findByIdInCompany(
    purchaseId: string,
    companyId: string,
    manager?: EntityManager,
  ): Promise<Purchase | null> {
    return this.getRepo(manager)
      .createQueryBuilder("p")
      .leftJoinAndSelect("p.customer", "cu")
      .where("p.id = :purchaseId", { purchaseId })
      .andWhere("p.company_id = :companyId", { companyId })
      .getOne();
  }

  async findByCompanyAndInvoice(
    companyId: string,
    invoiceNumber: string,
    manager?: EntityManager,
  ): Promise<Purchase | null> {
    return this.getRepo(manager)
      .createQueryBuilder("p")
      .where("p.company_id = :companyId", { companyId })
      .andWhere("p.invoice_number = :invoiceNumber", { invoiceNumber })
      .getOne();
  }

  async listByCompany(
    opts: ListPurchasesOptions,
    manager?: EntityManager,
  ): Promise<{ items: Purchase[]; total: number }> {
    const { companyId, page, limit, search, customerId, from, to, sortBy, sortOrder } = opts;
    const qb = this.getRepo(manager)
      .createQueryBuilder("p")
      .leftJoinAndSelect("p.customer", "cu")
      .where("p.company_id = :companyId", { companyId });

    if (customerId) {
      qb.andWhere("p.customer_id = :customerId", { customerId });
    }
    if (from) {
      qb.andWhere("p.submitted_at >= :from", { from });
    }
    if (to) {
      qb.andWhere("p.submitted_at <= :to", { to });
    }
    if (search && search.trim() !== "") {
      qb.andWhere(
        "(p.invoice_number ILIKE :search OR p.full_name_snapshot ILIKE :search OR p.vehicle_number_snapshot ILIKE :search)",
        { search: `%${search.trim()}%` },
      );
    }

    const sortColumnMap: Record<PurchaseSortField, string> = {
      submittedAt: "p.submittedAt",
      invoiceAmount: "p.invoiceAmount",
    };
    const sortColumn = sortColumnMap[sortBy ?? "submittedAt"];
    const direction: SortOrder = sortOrder === "ASC" ? "ASC" : "DESC";

    qb.orderBy(sortColumn, direction)
      .addOrderBy("p.id", "ASC")
      .take(limit)
      .skip((page - 1) * limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async create(data: Partial<Purchase>, manager?: EntityManager): Promise<Purchase> {
    const repo = this.getRepo(manager);
    return repo.save(repo.create(data));
  }

  /**
   * Monthly report: totals plus the top spenders, aggregated in the database.
   *
   * Replaces a client-side loop that paginated every purchase in the month 100 rows at
   * a time — sequentially — and summed them in the browser. A company with 10,000
   * purchases in a month meant 100 round trips before the page could render anything,
   * and every one of those rows crossed the wire only to be reduced to ten numbers.
   *
   * `RANK()` rather than `ROW_NUMBER()` is what preserves the old behaviour exactly:
   * the previous code took the top ten *and everyone tied with the tenth*, and RANK
   * gives tied totals the same rank, so `rnk <= 10` reproduces that without the caller
   * having to know. ROW_NUMBER would silently cut one of two identical top spenders.
   *
   * The window runs over the aggregate, not the raw rows, so it ranks customers rather
   * than individual purchases.
   */
  async getMonthlyReport(
    params: { companyId: string; from: Date; to: Date },
    manager?: EntityManager,
  ): Promise<{ totals: MonthlyTotals; topCustomers: TopCustomerRow[] }> {
    const runner = manager ?? AppDataSource.manager;

    const [totals] = (await runner.query(
      `SELECT COUNT(*)::int                          AS purchase_count,
              COALESCE(SUM(p."invoice_amount"), 0)   AS total_amount,
              COUNT(DISTINCT p."customer_id")::int   AS unique_customers
         FROM "purchases" p
        WHERE p."company_id" = $1
          AND p."deleted_at" IS NULL
          AND p."submitted_at" >= $2
          AND p."submitted_at" < $3`,
      [params.companyId, params.from, params.to],
    )) as [{ purchase_count: number; total_amount: string; unique_customers: number }];

    const rows = (await runner.query(
      `WITH agg AS (
         SELECT p."customer_id"                              AS customer_id,
                MAX(p."full_name_snapshot")                  AS full_name,
                MAX(p."vehicle_number_snapshot")             AS vehicle_number,
                MAX(c."mobile")                              AS mobile,
                SUM(p."invoice_amount")                      AS total_spend,
                COUNT(*)::int                                AS purchase_count,
                MAX(p."submitted_at")                        AS last_activity
           FROM "purchases" p
           JOIN "customers" c ON c."id" = p."customer_id"
          WHERE p."company_id" = $1
            AND p."deleted_at" IS NULL
            AND p."submitted_at" >= $2
            AND p."submitted_at" < $3
          GROUP BY p."customer_id"
       ),
       ranked AS (
         SELECT agg.*, RANK() OVER (ORDER BY total_spend DESC) AS rnk FROM agg
       )
       SELECT customer_id, full_name, vehicle_number, mobile,
              total_spend, purchase_count, last_activity
         FROM ranked
        WHERE rnk <= 10
        ORDER BY total_spend DESC, purchase_count DESC`,
      [params.companyId, params.from, params.to],
    )) as TopCustomerRow[];

    return {
      totals: {
        purchaseCount: totals.purchase_count,
        totalAmount: totals.total_amount,
        uniqueCustomers: totals.unique_customers,
      },
      topCustomers: rows,
    };
  }
}
