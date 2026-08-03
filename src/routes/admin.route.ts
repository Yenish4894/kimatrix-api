import { Router } from "express";
import { SuperAdminController } from "@/controllers/SuperAdminController";
import { superAdminMiddleware } from "@/middleware/auth";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  companyIdParamSchema,
  createPlanSchema,
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
// Note there is no DELETE. Plans are referenced by payments and by companies with a
// live subscription, so removing one would orphan real billing records — the FKs are
// RESTRICT for exactly that reason. Disable hides a plan from new buyers; editing a
// price or duration archives the plan and creates a successor.

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

export default router;
