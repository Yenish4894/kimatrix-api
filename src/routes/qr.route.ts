import { Router } from "express";
import { QrController } from "@/controllers/QrController";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import { qrTokenParamSchema, submitPurchaseSchema } from "@/validation/schemas/qr.schema";
import { qrSubmitPerDayLimiter, qrSubmitPerMinuteLimiter } from "@/middleware/rateLimit";

const router = Router();
const controller = new QrController();

router.get(
  "/:qrToken",
  validateRequest(qrTokenParamSchema, ValidationTarget.PARAMS),
  controller.resolve,
);

router.post(
  "/:qrToken/submit",
  validateRequest(qrTokenParamSchema, ValidationTarget.PARAMS),
  validateRequest(submitPurchaseSchema, ValidationTarget.BODY),
  qrSubmitPerMinuteLimiter,
  qrSubmitPerDayLimiter,
  controller.submit,
);

export default router;
