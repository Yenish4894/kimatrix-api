import { Router } from "express";
import { QrController } from "@/controllers/QrController";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import { qrTokenParamSchema, submitPurchaseSchema } from "@/validation/schemas/qr.schema";
import {
  qrSubmitPerDayLimiter,
  qrSubmitPerDevicePerDayLimiter,
  qrSubmitPerMinuteLimiter,
} from "@/middleware/rateLimit";

const router = Router();
const controller = new QrController();

router.get(
  "/:qrToken",
  validateRequest(qrTokenParamSchema, ValidationTarget.PARAMS),
  controller.resolve,
);

// Limiters BEFORE the validators. With the validators first, a request that failed
// validation was answered 400 before any limiter counted it, so malformed payloads
// probed the endpoint (and exercised the validator) at unlimited speed.
router.post(
  "/:qrToken/submit",
  qrSubmitPerMinuteLimiter,
  qrSubmitPerDayLimiter,
  // No mobile in the key, so rotating the phone number cannot escape it.
  qrSubmitPerDevicePerDayLimiter,
  validateRequest(qrTokenParamSchema, ValidationTarget.PARAMS),
  validateRequest(submitPurchaseSchema, ValidationTarget.BODY),
  controller.submit,
);

export default router;
