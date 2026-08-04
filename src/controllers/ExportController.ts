import type { NextFunction, Request, Response } from "express";
import { ExportService, type ExportDataset, type ExportFormat } from "@/services/ExportService";
import { UnauthorizedError } from "@/errors/index";

/**
 * Does NOT extend BaseController.
 *
 * `BaseController.handle` wraps the result in the standard
 * `{ success, message, data }` envelope and calls `res.json()`. An export is a file
 * download: it sets its own `Content-Type` and `Content-Disposition`, writes its body
 * incrementally, and must never be wrapped. Routing it through `handle` would buffer
 * the whole dataset just to re-serialise it.
 */
export class ExportController {
  private exportService = new ExportService();

  private stream = (dataset: ExportDataset) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const company = req.company;
        if (!company) throw UnauthorizedError("Company context missing");

        const format = ((req.query["format"] as string | undefined) ?? "csv") as ExportFormat;
        const filename = this.exportService.filename(dataset, format);

        res.setHeader(
          "Content-Type",
          format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        // The row count is unknown up front, so there is no Content-Length to send.
        // Without this, a proxy may buffer the entire response to compute one —
        // which would undo the streaming.
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");

        await this.exportService.streamDataset(dataset, format, company.id, res);
      } catch (err) {
        // Only reachable before the first byte — streamDataset destroys the socket
        // itself once the response has started, because the status line is already
        // committed and an error envelope can no longer be sent.
        next(err);
      }
    };
  };

  exportCustomers = this.stream("customers");
  exportPurchases = this.stream("purchases");
}
