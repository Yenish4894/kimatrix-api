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
      // 2xx = "we have taken responsibility for this event".
      res.status(200).json({ received: true });
    } catch (err) {
      // 5xx = "we failed to process it, please send it again."
      //
      // This previously answered 200 unconditionally with the comment "PayPal retries
      // on non-2xx" — which is true, and is exactly why swallowing the error was wrong.
      // The webhook is the ONLY backstop for a capture that succeeded at PayPal but
      // whose commit didn't land here, and there is no reconciliation job. A DB blip
      // therefore discarded that event permanently: money taken, subscription never
      // granted, and nothing to notice it.
      //
      // Note `handleWebhook` still returns early (2xx) for an invalid signature or an
      // event type we don't handle — those are genuinely nothing to do, not failures.
      logger.error(
        { err, requestId: req.id },
        "PayPal webhook processing failed — returning 5xx so PayPal retries",
      );
      res.status(500).json({ received: false });
    }
  };
}
