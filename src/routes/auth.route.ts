import { Router } from "express";
import { AuthController } from "@/controllers/AuthController";
import { EmailChangeController } from "@/controllers/EmailChangeController";
import { authMiddleware } from "@/middleware/auth";
import {
  emailChangeConfirmLimiter,
  emailChangeRequestLimiter,
  emailVerificationResendLimiter,
  loginLimiter,
  passwordResetConfirmLimiter,
  passwordResetRequestLimiter,
  registerLimiter,
} from "@/middleware/rateLimit";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  emailChangeConfirmSchema,
  emailChangeRequestSchema,
  emailVerificationConfirmSchema,
  loginSchema,
  passwordChangeSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshTokenSchema,
  registerCompanySchema,
} from "@/validation/schemas/auth.schema";

const router = Router();
const authController = new AuthController();
const emailChangeController = new EmailChangeController();

router.post(
  "/register/company",
  registerLimiter,
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

// Authenticated: the user is already logged in after registering, so resend needs
// no email in the body and therefore cannot be used to probe which addresses exist.
router.post(
  "/email-verification/resend",
  authMiddleware,
  emailVerificationResendLimiter,
  authController.resendEmailVerification,
);

// Public: the recipient clicks this from their inbox, and may well not have a live
// session in the browser they open it in.
router.post(
  "/email-verification/confirm",
  validateRequest(emailVerificationConfirmSchema, ValidationTarget.BODY),
  authController.confirmEmailVerification,
);

// Changing the login email. The request needs a session AND the current password; the
// confirm is public, because the link is opened from the NEW mailbox, often in a
// browser with no session.
router.post(
  "/email-change/request",
  authMiddleware,
  emailChangeRequestLimiter,
  validateRequest(emailChangeRequestSchema, ValidationTarget.BODY),
  emailChangeController.requestEmailChange,
);

router.post(
  "/email-change/confirm",
  emailChangeConfirmLimiter,
  validateRequest(emailChangeConfirmSchema, ValidationTarget.BODY),
  emailChangeController.confirmEmailChange,
);

export default router;
