import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import { SuperAdminService } from "@/services/SuperAdminService";
import { PlanService } from "@/services/PlanService";
import { SettingsService } from "@/services/SettingsService";
import { AuditService } from "@/services/AuditService";
import { UnauthorizedError } from "@/errors/index";
import type {
  CreatePlanBody,
  ListCompaniesQueryInput,
  UpdatePlanBody,
  UpdateSettingsBody,
} from "@/validation/schemas/admin.schema";

export class SuperAdminController extends BaseController {
  private service = new SuperAdminService();
  private planService = new PlanService();
  private settingsService = new SettingsService();
  private auditService = new AuditService();

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

  // ─── Plan management ─────────────────────────────────────────

  listPlans = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const plans = await this.planService.listForAdmin();
      return { data: plans };
    });
  };

  createPlan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const plan = await this.planService.create(req.body as CreatePlanBody, this.actor(req));
      return { data: plan, message: "Plan created." };
    });
  };

  updatePlan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const planId = req.params["planId"] as string;
      const plan = await this.planService.update(
        planId,
        req.body as UpdatePlanBody,
        this.actor(req),
      );
      // A different id coming back means the edit was versioned rather than applied in
      // place. Say so plainly — the admin needs to know a new plan now exists.
      const wasVersioned = plan.id !== planId;
      return {
        data: plan,
        message: wasVersioned
          ? "A new version of this plan was created. Companies already subscribed keep the plan they bought."
          : "Plan updated.",
      };
    });
  };

  setPlanActive = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const planId = req.params["planId"] as string;
      const { isActive } = req.body as { isActive: boolean };
      const plan = await this.planService.setActive(planId, isActive, this.actor(req));
      return {
        data: plan,
        message: isActive
          ? "Plan is now available to buy."
          : "Plan hidden. Companies already subscribed keep it until it expires.",
      };
    });
  };

  // ─── Platform settings ───────────────────────────────────────

  getSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const settings = await this.settingsService.getSettings();
      return { data: settings };
    });
  };

  updateSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const actor = this.actor(req);
      const body = req.body as UpdateSettingsBody;
      const before = await this.settingsService.getSettings();

      if (body.trialDurationDays !== undefined) {
        await this.settingsService.setTrialDurationDays(body.trialDurationDays, actor.id);
      }
      if (body.platformCurrency !== undefined) {
        await this.settingsService.setPlatformCurrency(body.platformCurrency, actor.id);
      }

      const after = await this.settingsService.getSettings();
      await this.auditService.record({
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "setting.update",
        entityType: "settings",
        entityId: "platform",
        before: before as unknown as Record<string, unknown>,
        after: after as unknown as Record<string, unknown>,
      });

      return { data: after, message: "Settings saved." };
    });
  };

  private actor(req: Request): { id: string; email: string } {
    if (!req.user) throw UnauthorizedError("Admin context missing");
    return { id: req.user.id, email: req.user.email };
  }
}
