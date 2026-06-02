import { Router } from "express";
import { PaymentController } from "@/controllers/PaymentController";
import { billingCompanyMiddleware } from "@/middleware/auth";

const router = Router();
const controller = new PaymentController();

// public — anyone can see available plans
router.get("/plans", controller.getPlans);

// company-authenticated — initiate + capture
router.post("/paypal/create-order", billingCompanyMiddleware, controller.createOrder);
router.post("/paypal/capture-order", billingCompanyMiddleware, controller.captureOrder);

// public — PayPal-signed webhook (no auth, raw body preserved via app.ts verify callback)
router.post("/paypal/webhook", controller.webhook);

export default router;
