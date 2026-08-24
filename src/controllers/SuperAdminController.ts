import type { NextFunction, Request, Response } from "express";
import { BaseController } from "@/controllers/BaseController";
import type {
  ExtendTrialInput,
  ReleaseTrialIdentityInput,
  SetCompInput,
  AdminDeletionInput,
  SendBulkEmailInput,
} from "@/validation/schemas/admin.schema";
import type { TrialIdentity } from "@/entities/TrialIdentity";
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
      // Orchestration lives in the service: the two settings must be written in one
      // transaction, or a rejected currency change leaves an already-committed trial
      // length behind while the response says 409.
      const after = await this.settingsService.updateSettings(
        req.body as UpdateSettingsBody,
        this.actor(req),
      );
      return { data: after, message: "Settings saved." };
    });
  };

  private actor(req: Request): { id: string; email: string } {
    if (!req.user) throw UnauthorizedError("Admin context missing");
    return { id: req.user.id, email: req.user.email };
  }

  extendTrial = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { companyId } = req.params as { companyId: string };
      const { days } = req.body as ExtendTrialInput;
      const result = await this.service.extendTrial(companyId, days, req.user!.id);
      return {
        data: result,
        message: `Trial extended. It now runs until ${result.trialEndsAt.toISOString().slice(0, 10)}.`,
      };
    });
  };

  setComp = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { companyId } = req.params as { companyId: string };
      const input = req.body as SetCompInput;
      const result = await this.service.setComp(
        companyId,
        {
          isComped: input.isComped,
          compedUntil: input.compedUntil ?? null,
          reason: input.reason ?? null,
        },
        req.user!.id,
      );
      return {
        data: result,
        message: input.isComped ? "Complimentary access granted." : "Complimentary access removed.",
      };
    });
  };

  listTrialIdentities = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { companyId } = req.params as { companyId: string };
      const identities = await this.service.listTrialIdentities(companyId);
      return {
        // Only the masked preview leaves the server. The stored value is an HMAC and
        // cannot be reversed, but the preview is what support actually needs, and
        // returning less is the right default for a table of contact details.
        data: identities.map((i: TrialIdentity) => ({
          id: i.id,
          type: i.identifierType,
          preview: i.identifierPreview,
          claimedAt: i.claimedAt,
          releasedAt: i.releasedAt,
          releaseReason: i.releaseReason,
        })),
      };
    });
  };

  releaseTrialIdentity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { identityId } = req.params as { identityId: string };
      const { reason } = req.body as ReleaseTrialIdentityInput;
      await this.service.releaseTrialIdentity(identityId, reason, req.user!.id);
      return { data: null, message: "That identifier can be used for a free trial again." };
    });
  };

  getDeletionStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { companyId } = req.params as { companyId: string };
      return { data: await this.service.getDeletionStatus(companyId) };
    });
  };

  requestDeletion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { companyId } = req.params as { companyId: string };
      const { reason } = req.body as AdminDeletionInput;
      const status = await this.service.requestDeletionForCompany(
        companyId,
        { id: req.user!.id, email: req.user!.email },
        reason,
      );
      return {
        data: status,
        message: status.purgeAt
          ? `Deletion scheduled. The data is erased on ${status.purgeAt.toISOString().slice(0, 10)}.`
          : "Deletion scheduled.",
      };
    });
  };

  cancelDeletion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { companyId } = req.params as { companyId: string };
      const { reason } = req.body as AdminDeletionInput;
      await this.service.cancelDeletionForCompany(
        companyId,
        { id: req.user!.id, email: req.user!.email },
        reason,
      );
      return { data: null, message: "Deletion called off. Nothing will be erased." };
    });
  };

  // ─── Bulk email ───────────────────────────────────────────────────────────

  sendBulkEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const { subject, body, companyIds, extraEmails } = req.body as SendBulkEmailInput;
      // Multipart, so the arrays arrive as strings. A form field cannot express a JSON
      // array, and silently treating "a,b" as one address would mail nobody.
      const file = (req as Request & { file?: Express.Multer.File }).file;

      const result = await this.service.sendBulkEmail(
        { id: req.user!.id, email: req.user!.email },
        subject,
        body,
        companyIds,
        extraEmails,
        file ? { path: file.path, filename: file.originalname, size: file.size } : undefined,
      );
      return { data: result, message: `Email queued for ${result.recipientCount} recipient(s).` };
    });
  };

  listBulkEmailLogs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await this.handle(req, res, next, async () => {
      const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10) || 1);
      const limit = Math.min(
        50,
        Math.max(1, parseInt((req.query["limit"] as string) ?? "10", 10) || 10),
      );
      const { items, total } = await this.service.listBulkEmailLogs(page, limit);
      return { data: this.paginationResponse(items, total, page, limit) };
    });
  };
}
