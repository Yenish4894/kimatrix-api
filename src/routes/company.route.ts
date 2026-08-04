import { Router } from "express";
import { CompanyController } from "@/controllers/CompanyController";
import { ExportController } from "@/controllers/ExportController";
import { companyMiddleware } from "@/middleware/auth";
import { requireActiveSubscription, requireExportAllowed } from "@/middleware/subscription";
import { validateRequest, ValidationTarget } from "@/middleware/validation";
import {
  customerIdParamSchema,
  listCustomersQuerySchema,
  listPurchasesQuerySchema,
  purchaseIdParamSchema,
  exportQuerySchema,
  updateProfileSchema,
} from "@/validation/schemas/company.schema";

const router = Router();
const controller = new CompanyController();
const exportController = new ExportController();

// all company routes require a valid JWT + active company
router.use(companyMiddleware);

// profile + settings — accessible even when subscription is expired
router.get("/profile", controller.getProfile);
router.put(
  "/profile",
  validateRequest(updateProfileSchema, ValidationTarget.BODY),
  controller.updateProfile,
);

// ─────────────────────────────────────────────────────────────────────────────
// DATA EXPORT — deliberately mounted ABOVE the requireActiveSubscription block.
//
// Export must keep working after a subscription or trial lapses: it is the entire
// "download your data and leave" half of the paywall, and both expiry emails link
// straight to it. Taking it away at expiry would mean holding a customer's own data
// hostage behind a payment.
//
// `requireExportAllowed` is a POSITIVE assertion of `entitlement.canExport`, not
// merely the absence of `requireActiveSubscription`. Someone will eventually add a
// blanket `router.use(requireActiveSubscription)` to this file; when they do, this
// still refuses deactivated accounts on its own terms rather than silently changing
// meaning. It is also the one gate that DOES block a deactivated (admin-banned)
// company — `canExport` is false only in that state.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/export/customers",
  requireExportAllowed,
  validateRequest(exportQuerySchema, ValidationTarget.QUERY),
  exportController.exportCustomers,
);
router.get(
  "/export/purchases",
  requireExportAllowed,
  validateRequest(exportQuerySchema, ValidationTarget.QUERY),
  exportController.exportPurchases,
);

// data routes — require an active, non-expired subscription
router.get("/stats", requireActiveSubscription, controller.getStats);

router.get(
  "/customers",
  requireActiveSubscription,
  validateRequest(listCustomersQuerySchema, ValidationTarget.QUERY),
  controller.listCustomers,
);
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
router.get(
  "/purchases/:purchaseId",
  requireActiveSubscription,
  validateRequest(purchaseIdParamSchema, ValidationTarget.PARAMS),
  controller.getPurchase,
);

export default router;
