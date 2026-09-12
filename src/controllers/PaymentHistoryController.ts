import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { PaymentHistoryService } from "@/services/PaymentHistoryService";
import { UnauthorizedError } from "@/errors/index";
import type { ListAdminPaymentsQueryInput } from "@/validation/schemas/payment.schema";

/**
 * Payment history and invoice PDFs, for a company's own payments and for admin.
 *
 * The lists use the standard envelope. The PDFs bypass it, as ReportController does,
 * because a file must never be wrapped in `{ success, data }`.
 */
export class PaymentHistoryController extends BaseController {
  private service = new PaymentHistoryService();

  listCompanyPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const { page, limit } = this.getPagination(req.query);
      const { items, total } = await this.service.listForCompany(company.id, page, limit);
      return { data: this.paginationResponse(items, total, page, limit) };
    });
  };

  listAdminPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const q = req.query as unknown as ListAdminPaymentsQueryInput;
      const { page, limit } = this.getPagination(q);
      const { items, total } = await this.service.listForAdmin({
        page,
        limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(q.from ? { from: new Date(q.from) } : {}),
        ...(q.to ? { to: new Date(q.to) } : {}),
      });
      return { data: this.paginationResponse(items, total, page, limit) };
    });
  };

  downloadCompanyInvoice = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      // Scoped to the caller's company in SQL: another company's id is a 404, never a
      // 403, so probing cannot tell which payment ids exist.
      await this.sendInvoice(res, req.params["paymentId"] as string, company.id);
    } catch (err) {
      next(err);
    }
  };

  downloadAdminInvoice = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.sendInvoice(res, req.params["paymentId"] as string, null);
    } catch (err) {
      next(err);
    }
  };

  private async sendInvoice(res: Response, paymentId: string, companyId: string | null) {
    // Finished in memory before anything is written, so an error still becomes a JSON
    // error response rather than a truncated file.
    const { filename, body } = await this.service.renderInvoice(paymentId, companyId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(body.length));
    // A billing address and contact email: keep it out of shared caches.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).end(body);
  }
}
