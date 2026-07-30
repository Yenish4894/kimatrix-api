import { Router } from "express";
import { PaymentController } from "@/controllers/PaymentController";
import { companyMiddleware } from "@/middleware/auth";

const router = Router();
const controller = new PaymentController();

// public — anyone can see available plans
router.get("/plans", controller.getPlans);

// company-authenticated — initiate + capture.
// Uses companyMiddleware, which allows every non-deactivated state through. That is
// required here: pending, expired and lapsed-trial companies are exactly the ones who
// need to pay. (This previously needed a separate `billingCompanyMiddleware`; once
// companyMiddleware stopped enforcing `isActive` the two became identical.)
router.post("/paypal/create-order", companyMiddleware, controller.createOrder);
router.post("/paypal/capture-order", companyMiddleware, controller.captureOrder);

// public — PayPal-signed webhook (no auth, raw body preserved via app.ts verify callback)
router.post("/paypal/webhook", controller.webhook);

export default router;
