import { Router } from "express";
import { AuthController } from "@/controllers/AuthController";
import { authMiddleware } from "@/middleware/auth";
import {
  loginLimiter,
  passwordResetConfirmLimiter,
  passwordResetRequestLimiter,
} from "@/middleware/rateLimit";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  loginSchema,
  passwordChangeSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshTokenSchema,
  registerCompanySchema,
} from "@/validation/schemas/auth.schema";

const router = Router();
const authController = new AuthController();

router.post(
  "/register/company",
  validateRequest(registerCompanySchema, ValidationTarget.BODY),
  authController.registerCompany,
);

router.post(
  "/login",
  loginLimiter,
  validateRequest(loginSchema, ValidationTarget.BODY),
  authController.login,
);

router.post(
  "/refresh",
  validateRequest(refreshTokenSchema, ValidationTarget.BODY),
  authController.refreshTokens,
);

router.post(
  "/logout",
  validateRequest(refreshTokenSchema, ValidationTarget.BODY),
  authController.logout,
);

router.post(
  "/password-reset/request",
  passwordResetRequestLimiter,
  validateRequest(passwordResetRequestSchema, ValidationTarget.BODY),
  authController.requestPasswordReset,
);

router.post(
  "/password-reset/confirm",
  passwordResetConfirmLimiter,
  validateRequest(passwordResetConfirmSchema, ValidationTarget.BODY),
  authController.confirmPasswordReset,
);

router.post(
  "/password-change",
  authMiddleware,
  validateRequest(passwordChangeSchema, ValidationTarget.BODY),
  authController.changePassword,
);

export default router;
