import type { NextFunction, Request, Response } from "express";
import { ReportService } from "@/services/ReportService";
import type { ReportKind } from "@/pdf/reports";
import { UnauthorizedError } from "@/errors/index";

/**
 * Does NOT extend BaseController, for the same reason ExportController does not: these
 * responses are files. They set their own Content-Type and Content-Disposition and
 * must never be wrapped in the `{ success, data }` envelope.
 *
 * Unlike the CSV export, a PDF is not streamed — a PDF's page count and layout are
 * only known once every row is composed, so the document is finished in memory and
 * sent in one piece. That also means an error is always reportable: nothing has been
 * written when it is thrown, so `next(err)` still produces a proper JSON error rather
 * than a truncated file.
 */
export class ReportController {
  private reportService = new ReportService();

  private download = (kind: ReportKind) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const company = req.company;
        if (!company) throw UnauthorizedError("Company context missing");

        const { filename, body } = await this.reportService.render(company.id, kind);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Length", String(body.length));
        // Customer names and phone numbers — never let a proxy or the browser keep a copy.
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");

        res.status(200).end(body);
      } catch (err) {
        next(err);
      }
    };
  };

  downloadTop10 = this.download("top10");
  downloadCustomers = this.download("customers");
  downloadPurchases = this.download("purchases");
}
