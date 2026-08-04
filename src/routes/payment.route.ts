import { Router } from "express";
import { PaymentController } from "@/controllers/PaymentController";
import { companyMiddleware } from "@/middleware/auth";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  cancelSubscriptionSchema,
  captureOrderSchema,
  changePlanSchema,
  confirmSubscriptionSchema,
  createOrderSchema,
  subscribeSchema,
} from "@/validation/schemas/payment.schema";

const router = Router();
const controller = new PaymentController();

// public — anyone can see available plans
router.get("/plans", controller.getPlans);

// company-authenticated — initiate + capture.
// Uses companyMiddleware, which allows every non-deactivated state through. That is
// required here: pending, expired and lapsed-trial companies are exactly the ones who
// need to pay. (This previously needed a separate `billingCompanyMiddleware`; once
// companyMiddleware stopped enforcing `isActive` the two became identical.)
router.post(
  "/paypal/create-order",
  companyMiddleware,
  validateRequest(createOrderSchema, ValidationTarget.BODY),
  controller.createOrder,
);
router.post(
  "/paypal/capture-order",
  companyMiddleware,
  validateRequest(captureOrderSchema, ValidationTarget.BODY),
  controller.captureOrder,
);

// ─── Subscriptions ──────────────────────────────────────────────────────────
//
// Same middleware as the order routes, and for the same reason: pending, expired and
// lapsed-trial companies are exactly the ones who need to subscribe.
router.post(
  "/subscriptions",
  companyMiddleware,
  validateRequest(subscribeSchema, ValidationTarget.BODY),
  controller.subscribe,
);
router.post(
  "/subscriptions/confirm",
  companyMiddleware,
  validateRequest(confirmSubscriptionSchema, ValidationTarget.BODY),
  controller.confirmSubscription,
);
router.get("/subscriptions/status", companyMiddleware, controller.subscriptionStatus);
router.post(
  "/subscriptions/cancel",
  companyMiddleware,
  validateRequest(cancelSubscriptionSchema, ValidationTarget.BODY),
  controller.cancelSubscription,
);
router.post(
  "/subscriptions/change-plan",
  companyMiddleware,
  validateRequest(changePlanSchema, ValidationTarget.BODY),
  controller.changePlan,
);

// public — PayPal-signed webhook (no auth, raw body preserved via app.ts verify callback)
router.post("/paypal/webhook", controller.webhook);

export default router;
