import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { AuthService } from "@/services/AuthService";
import type {
  EmailVerificationConfirmInput,
  LoginInput,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RefreshTokenInput,
  RegisterCompanyInput,
} from "@/validation/schemas/auth.schema";

export class AuthController extends BaseController {
  private authService = new AuthService();

  registerCompany = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as RegisterCompanyInput;
      const result = await this.authService.registerCompany(payload, {
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      return {
        data: result,
        message: "Registration successful.",
        statusCode: 201,
      };
    });
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as LoginInput;
      const result = await this.authService.login(payload, {
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      return { data: result, message: "Login successful" };
    });
  };

  refreshTokens = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as RefreshTokenInput;
      const result = await this.authService.refreshTokens(payload, {
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      return { data: result, message: "Tokens refreshed" };
    });
  };

  logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as RefreshTokenInput;
      await this.authService.logout(payload.refreshToken);
      return { data: null, message: "Logged out" };
    });
  };

  requestPasswordReset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as PasswordResetRequestInput;
      await this.authService.requestPasswordReset(payload, {
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      return {
        data: null,
        message: "If an account exists for this email, a reset link has been sent.",
      };
    });
  };

  confirmPasswordReset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as PasswordResetConfirmInput;
      await this.authService.confirmPasswordReset(payload);
      return { data: null, message: "Password has been reset. Please log in again." };
    });
  };

  resendEmailVerification = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    await this.handle(req, res, next, async () => {
      if (!req.user) throw new Error("Auth context missing");
      await this.authService.requestEmailVerification(req.user.id, {
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      });
      // Same message whether a mail was sent or the address was already verified —
      // no reason to expose the difference, and the UI reads better for it.
      return { data: null, message: "Verification email sent. Please check your inbox." };
    });
  };

  confirmEmailVerification = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const payload = req.body as EmailVerificationConfirmInput;
      await this.authService.confirmEmailVerification(payload.token);
      return { data: null, message: "Your email has been confirmed." };
    });
  };

  changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      if (!req.user) throw new Error("Auth context missing");
      const payload = req.body as PasswordChangeInput;
      await this.authService.changePassword(req.user.id, payload);
      return { data: null, message: "Password changed. Please log in again." };
    });
  };
}
