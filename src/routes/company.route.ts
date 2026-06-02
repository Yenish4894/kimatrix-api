import { Router } from "express";
import { CompanyController } from "@/controllers/CompanyController";
import { companyMiddleware } from "@/middleware/auth";
import { requireActiveSubscription } from "@/middleware/subscription";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  customerIdParamSchema,
  listCustomersQuerySchema,
  listPurchasesQuerySchema,
  purchaseIdParamSchema,
  updateProfileSchema,
} from "@/validation/schemas/company.schema";

const router = Router();
const controller = new CompanyController();

// all company routes require a valid JWT + active company
router.use(companyMiddleware);

// profile + settings — accessible even when subscription is expired
router.get("/profile", controller.getProfile);
router.put(
  "/profile",
  validateRequest(updateProfileSchema, ValidationTarget.BODY),
  controller.updateProfile,
);

// data routes — require an active, non-expired subscription
router.get("/stats", requireActiveSubscription, controller.getStats);

router.get(
  "/customers",
  requireActiveSubscription,
  validateRequest(listCustomersQuerySchema, ValidationTarget.QUERY),
  controller.listCustomers,
);
router.get("/customers/export", requireActiveSubscription, controller.exportCustomers);
router.get(
  "/customers/:customerId",
  requireActiveSubscription,
  validateRequest(customerIdParamSchema, ValidationTarget.PARAMS),
  controller.getCustomer,
);

router.get(
  "/purchases",
  requireActiveSubscription,
  validateRequest(listPurchasesQuerySchema, ValidationTarget.QUERY),
  controller.listPurchases,
);
router.get("/purchases/export", requireActiveSubscription, controller.exportPurchases);
router.get(
  "/purchases/:purchaseId",
  requireActiveSubscription,
  validateRequest(purchaseIdParamSchema, ValidationTarget.PARAMS),
  controller.getPurchase,
);

export default router;
