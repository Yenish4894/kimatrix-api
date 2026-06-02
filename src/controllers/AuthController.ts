import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { AuthService } from "@/services/AuthService";
import type {
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
        message:
          "Thank you for registering. Once your payment is verified, your account will be activated and you'll be able to log in.",
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

  changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      if (!req.user) throw new Error("Auth context missing");
      const payload = req.body as PasswordChangeInput;
      await this.authService.changePassword(req.user.id, payload);
      return { data: null, message: "Password changed. Please log in again." };
    });
  };
}
