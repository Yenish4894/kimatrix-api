import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { EmailChangeService } from "@/services/EmailChangeService";
import { UnauthorizedError } from "@/errors/index";
import type {
  EmailChangeConfirmInput,
  EmailChangeRequestInput,
} from "@/validation/schemas/auth.schema";

export class EmailChangeController extends BaseController {
  private service = new EmailChangeService();

  requestEmailChange = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      if (!req.user) throw UnauthorizedError("Authentication required");
      const result = await this.service.request(req.user.id, req.body as EmailChangeRequestInput);
      return { data: result, message: result.message };
    });
  };

  confirmEmailChange = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { token } = req.body as EmailChangeConfirmInput;
      const result = await this.service.confirm(token);
      return { data: result, message: result.message };
    });
  };
}
