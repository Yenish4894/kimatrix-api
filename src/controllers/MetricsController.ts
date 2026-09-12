import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { MetricsService } from "@/services/MetricsService";

export class MetricsController extends BaseController {
  private metricsService = new MetricsService();

  /** Public, body ignored. 204: the caller fires and forgets, so there is nothing to send. */
  recordVisit = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.metricsService.recordVisit();
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  visitors = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => ({
      data: await this.metricsService.getVisitorStats(),
    }));
  };
}
