import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { PaymentService } from "@/services/PaymentService";
import { BadRequestError } from "@/errors/index";
import { logger } from "@/utils/logger";

const paymentService = new PaymentService();

export class PaymentController extends BaseController {
  getPlans = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const plans = await paymentService.getPlans();
      return { data: plans, message: "Plans retrieved." };
    });
  };

  createOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const companyId = req.company!.id;
      const { planId } = req.body as { planId: string };
      if (!planId) throw BadRequestError("planId is required.");
      const result = await paymentService.initiatePayment(companyId, planId);
      return {
        data: result,
        message: "Order created. Redirect to approvalUrl to complete payment.",
        statusCode: 201,
      };
    });
  };

  captureOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const companyId = req.company!.id;
      const { paypalOrderId } = req.body as { paypalOrderId: string };
      if (!paypalOrderId) throw BadRequestError("paypalOrderId is required.");
      const result = await paymentService.capturePayment(companyId, paypalOrderId);
      return { data: result, message: "Payment captured. Your subscription is now active." };
    });
  };

  webhook = async (req: Request, res: Response): Promise<void> => {
    try {
      const headers: Record<string, string> = {};
      for (const key of [
        "paypal-transmission-id",
        "paypal-transmission-time",
        "paypal-cert-url",
        "paypal-auth-algo",
        "paypal-transmission-sig",
      ]) {
        headers[key] = (req.headers[key] as string) ?? "";
      }

      const rawBody = req.rawBody?.toString("utf8") ?? JSON.stringify(req.body);
      await paymentService.handleWebhook(headers, rawBody);
    } catch (err) {
      logger.error({ err }, "PayPal webhook handler threw unexpectedly");
    }
    // always 200 — PayPal retries on non-2xx
    res.status(200).json({ received: true });
  };
}
