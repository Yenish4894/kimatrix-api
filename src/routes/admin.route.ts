import { Router } from "express";
import { SuperAdminController } from "@/controllers/SuperAdminController";
import { superAdminMiddleware } from "@/middleware/auth";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  companyIdParamSchema,
  createPlanSchema,
  extendTrialSchema,
  releaseTrialIdentitySchema,
  setCompSchema,
  trialIdentityIdParamSchema,
  listCompaniesQuerySchema,
  planIdParamSchema,
  setPlanActiveSchema,
  updatePlanSchema,
  updateSettingsSchema,
} from "@/validation/schemas/admin.schema";

const router = Router();
const controller = new SuperAdminController();

router.use(superAdminMiddleware);

router.get("/stats", controller.getPlatformStats);

router.get(
  "/companies",
  validateRequest(listCompaniesQuerySchema, ValidationTarget.QUERY),
  controller.listCompanies,
);
router.get(
  "/companies/:companyId",
  validateRequest(companyIdParamSchema, ValidationTarget.PARAMS),
  controller.getCompany,
);
router.patch(
  "/companies/:companyId/deactivate",
  validateRequest(companyIdParamSchema, ValidationTarget.PARAMS),
  controller.deactivateCompany,
);
router.patch(
  "/companies/:companyId/activate",
  validateRequest(companyIdParamSchema, ValidationTarget.PARAMS),
  controller.activateCompany,
);

// ─── Plan management ───────────────────────────────────────────
// Note there is no DELETE. `payments.plan_id` is ON DELETE RESTRICT, so the database
// would refuse to remove a plan any customer has ever bought — and rightly so, since
// deleting it would destroy what that invoice was for. (`companies.current_plan_id` is
// SET NULL, so it would not block the delete; `payments` is what protects us.)
// Disable hides a plan from new buyers; editing a price or duration archives the plan
// and creates a successor.

router.get("/plans", controller.listPlans);

router.post(
  "/plans",
  validateRequest(createPlanSchema, ValidationTarget.BODY),
  controller.createPlan,
);

router.patch(
  "/plans/:planId",
  validateRequest(planIdParamSchema, ValidationTarget.PARAMS),
  validateRequest(updatePlanSchema, ValidationTarget.BODY),
  controller.updatePlan,
);

router.patch(
  "/plans/:planId/availability",
  validateRequest(planIdParamSchema, ValidationTarget.PARAMS),
  validateRequest(setPlanActiveSchema, ValidationTarget.BODY),
  controller.setPlanActive,
);

// ─── Platform settings (trial length, currency) ────────────────

router.get("/settings", controller.getSettings);

router.patch(
  "/settings",
  validateRequest(updateSettingsSchema, ValidationTarget.BODY),
  controller.updateSettings,
);

// ─── Subscription / trial administration ────────────────────────────────────
//
// All of these write the entitlement projection themselves rather than waiting for the
// hourly cron, so the admin sees the result of their own action immediately instead of
// a stale badge.
router.post(
  "/companies/:companyId/trial/extend",
  validateRequest(companyIdParamSchema, ValidationTarget.PARAMS),
  validateRequest(extendTrialSchema, ValidationTarget.BODY),
  controller.extendTrial,
);

router.patch(
  "/companies/:companyId/comp",
  validateRequest(companyIdParamSchema, ValidationTarget.PARAMS),
  validateRequest(setCompSchema, ValidationTarget.BODY),
  controller.setComp,
);

router.get(
  "/companies/:companyId/trial-identities",
  validateRequest(companyIdParamSchema, ValidationTarget.PARAMS),
  controller.listTrialIdentities,
);

// The safety valve for a burned identifier. See SuperAdminService.releaseTrialIdentity.
router.post(
  "/trial-identities/:identityId/release",
  validateRequest(trialIdentityIdParamSchema, ValidationTarget.PARAMS),
  validateRequest(releaseTrialIdentitySchema, ValidationTarget.BODY),
  controller.releaseTrialIdentity,
);

export default router;
