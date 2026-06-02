import { Router } from "express";
import { SuperAdminController } from "@/controllers/SuperAdminController";
import { superAdminMiddleware } from "@/middleware/auth";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import { companyIdParamSchema, listCompaniesQuerySchema } from "@/validation/schemas/admin.schema";

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

export default router;
