import { AppDataSource } from "data-source";
import { BadRequestError, NotFoundError } from "@/middleware/errorHandler";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import {
  renderCustomersPdf,
  renderPurchasesPdf,
  renderTop10Pdf,
  type CustomerRow,
  type PurchaseRow,
  type ReportKind,
} from "@/pdf/reports";
import { logger } from "@/utils/logger";

/**
 * Upper bound on rows pulled into one PDF.
 *
 * A PDF cannot be streamed — page count and layout are only known once every row is
 * composed — so the whole report is held in memory. That is fine at the sizes this
 * platform sees and would not be at fifty thousand rows, so it fails with a clear
 * message rather than taking the process down with it.
 */
const MAX_REPORT_ROWS = 5_000;

export class ReportService {
  private companyRepository = new CompanyRepository();

  /**
   * Render one of the three reports for a company.
   *
   * Deliberately does not consult entitlement: the route decides who may call this,
   * and the same method serves both the download endpoint and the expiry email, where
   * the company by definition no longer has access.
   */
  async render(companyId: string, kind: ReportKind): Promise<{ filename: string; body: Buffer }> {
    const company = await this.companyRepository.findById(companyId);
    if (!company) throw NotFoundError("Company not found");

    const ctx = {
      companyName: company.name,
      country: company.country ?? "",
      // Decides whether the reports carry a vehicle column at all. A shop cannot record
      // one, so for a shop that column is guaranteed blank on every row.
      businessType: company.businessType,
    };
    const slug = company.name
      .replaceAll(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-|-$/g, "");
    const today = new Date().toISOString().split("T")[0];

    if (kind === "purchases") {
      const rows = await this.purchaseRows(companyId);
      return {
        filename: `kimates-transactions-${slug}-${today}.pdf`,
        body: renderPurchasesPdf(rows, ctx),
      };
    }

    const rows = await this.customerRows(companyId);
    if (kind === "top10") {
      return { filename: `kimates-top10-${slug}-${today}.pdf`, body: renderTop10Pdf(rows, ctx) };
    }
    return {
      filename: `kimates-customers-${slug}-${today}.pdf`,
      body: renderCustomersPdf(rows, ctx),
    };
  }

  /**
   * Every customer, ordered by spend in the database rather than in Node.
   *
   * The ranking is recomputed in the PDF layer anyway — it has to be, to produce the
   * shared ranks for ties — but ordering here means the row cap keeps the biggest
   * spenders if a very large company ever hits it, instead of an arbitrary slice.
   */
  private async customerRows(companyId: string): Promise<CustomerRow[]> {
    const rows = (await AppDataSource.manager.query(
      `SELECT c."full_name", c."mobile", c."vehicle_number", c."total_invoice_amount",
              c."submission_count", c."first_submission_at", c."last_submission_at"
         FROM "customers" c
        WHERE c."company_id" = $1 AND c."deleted_at" IS NULL
        ORDER BY c."total_invoice_amount" DESC NULLS LAST, c."id"
        LIMIT $2`,
      [companyId, MAX_REPORT_ROWS + 1],
    )) as CustomerRow[];

    return this.capped(rows, companyId, "customers");
  }

  private async purchaseRows(companyId: string): Promise<PurchaseRow[]> {
    const rows = (await AppDataSource.manager.query(
      `SELECT p."invoice_number", p."invoice_amount", cu."mobile",
              p."full_name_snapshot", p."vehicle_number_snapshot", p."submitted_at"
         FROM "purchases" p
         INNER JOIN "customers" cu ON cu."id" = p."customer_id"
        WHERE p."company_id" = $1 AND p."deleted_at" IS NULL
        ORDER BY p."submitted_at" DESC, p."id"
        LIMIT $2`,
      [companyId, MAX_REPORT_ROWS + 1],
    )) as PurchaseRow[];

    return this.capped(rows, companyId, "purchases");
  }

  /** One extra row is fetched purely so this can tell "exactly at the cap" from "over". */
  private capped<T>(rows: T[], companyId: string, dataset: string): T[] {
    if (rows.length <= MAX_REPORT_ROWS) return rows;
    logger.warn({ companyId, dataset, cap: MAX_REPORT_ROWS }, "Report exceeds the PDF row cap");
    throw BadRequestError(
      `This report is too large to produce as a PDF. Please contact support and we will send it to you.`,
    );
  }
}
