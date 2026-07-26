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
}
