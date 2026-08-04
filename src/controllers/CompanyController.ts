import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { CompanyService } from "@/services/CompanyService";
import { UnauthorizedError } from "@/errors/index";
import type {
  ListCustomersQueryInput,
  ListPurchasesQueryInput,
  MonthlyReportQueryInput,
  UpdateProfileInput,
} from "@/validation/schemas/company.schema";

export class CompanyController extends BaseController {
  private companyService = new CompanyService();

  getProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      return { data: this.companyService.getProfile(company, req.user?.emailVerifiedAt) };
    });
  };

  updateProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const input = req.body as UpdateProfileInput;
      const updated = await this.companyService.updateProfile(
        company.id,
        input,
        req.user?.emailVerifiedAt,
      );
      return { data: updated, message: "Profile updated successfully" };
    });
  };

  getStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const stats = await this.companyService.getStats(company.id);
      return { data: stats };
    });
  };

  listCustomers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const query = req.query as unknown as ListCustomersQueryInput;
      const { items, total } = await this.companyService.listCustomers(company.id, query);
      return {
        data: this.paginationResponse(items, total, query.page, query.limit),
      };
    });
  };

  getCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const customerId = req.params["customerId"] as string;
      const customer = await this.companyService.getCustomer(company.id, customerId);
      return { data: customer };
    });
  };

  listPurchases = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const query = req.query as unknown as ListPurchasesQueryInput;
      const { items, total } = await this.companyService.listPurchases(company.id, query);
      return {
        data: this.paginationResponse(items, total, query.page, query.limit),
      };
    });
  };

  getPurchase = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const purchaseId = req.params["purchaseId"] as string;
      const purchase = await this.companyService.getPurchase(company.id, purchaseId);
      return { data: purchase };
    });
  };

  getMonthlyReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const company = req.company;
      if (!company) throw UnauthorizedError("Company context missing");
      const { year, month } = req.query as unknown as MonthlyReportQueryInput;
      return { data: await this.companyService.getMonthlyReport(company.id, year, month) };
    });
  };
}
