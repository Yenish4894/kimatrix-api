import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { QrService } from "@/services/QrService";
import type { SubmitPurchaseInput } from "@/validation/schemas/qr.schema";

export class QrController extends BaseController {
  private qrService = new QrService();

  resolve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const qrToken = req.params["qrToken"] as string;
      const result = await this.qrService.resolveByToken(qrToken);
      return { data: result };
    });
  };

  submit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const qrToken = req.params["qrToken"] as string;
      const payload = req.body as SubmitPurchaseInput;
      const result = await this.qrService.submitPurchase(qrToken, payload, {
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      return {
        data: result,
        message: "Submission recorded. Thank you!",
        statusCode: 201,
      };
    });
  };
}
