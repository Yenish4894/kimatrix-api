import { AppDataSource } from "data-source";
import type { CustomerRow, PurchaseRow } from "@/pdf/reports";

/** Rows for the PDF reports. `limit` is the caller's cap (+1 to detect overflow). */
export class ReportRepository {
  /** Every customer, ordered by spend in the database rather than in Node. */
  async customerRows(companyId: string, limit: number): Promise<CustomerRow[]> {
    return (await AppDataSource.manager.query(
      `SELECT c."full_name", c."mobile", c."vehicle_number", c."total_invoice_amount",
              c."submission_count", c."first_submission_at", c."last_submission_at"
         FROM "customers" c
        WHERE c."company_id" = $1 AND c."deleted_at" IS NULL
        ORDER BY c."total_invoice_amount" DESC NULLS LAST, c."id"
        LIMIT $2`,
      [companyId, limit],
    )) as CustomerRow[];
  }

  /** Live (not voided) purchases, newest first. */
  async purchaseRows(companyId: string, limit: number): Promise<PurchaseRow[]> {
    return (await AppDataSource.manager.query(
      `SELECT p."invoice_number", p."invoice_amount", cu."mobile",
              p."full_name_snapshot", p."vehicle_number_snapshot", p."submitted_at"
         FROM "purchases" p
         INNER JOIN "customers" cu ON cu."id" = p."customer_id"
        WHERE p."company_id" = $1 AND p."deleted_at" IS NULL AND p."voided_at" IS NULL
        ORDER BY p."submitted_at" DESC, p."id"
        LIMIT $2`,
      [companyId, limit],
    )) as PurchaseRow[];
  }
}
