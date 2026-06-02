import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { SuperAdminService } from "@/services/SuperAdminService";
import { UnauthorizedError } from "@/errors/index";
import type { ListCompaniesQueryInput } from "@/validation/schemas/admin.schema";

export class SuperAdminController extends BaseController {
  private service = new SuperAdminService();

  listCompanies = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const query = req.query as unknown as ListCompaniesQueryInput;
      const { items, total } = await this.service.listCompanies(query);
      return { data: this.paginationResponse(items, total, query.page, query.limit) };
    });
  };

  getCompany = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const companyId = req.params["companyId"] as string;
      const company = await this.service.getCompany(companyId);
      return { data: company };
    });
  };

  deactivateCompany = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      if (!req.user) throw UnauthorizedError("Admin context missing");
      const companyId = req.params["companyId"] as string;
      await this.service.deactivateCompany(companyId, req.user.id);
      return { data: null, message: "Company deactivated" };
    });
  };

  activateCompany = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const companyId = req.params["companyId"] as string;
      await this.service.activateCompany(companyId);
      return { data: null, message: "Company activated" };
    });
  };

  getPlatformStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const stats = await this.service.getPlatformStats();
      return { data: stats };
    });
  };
}
