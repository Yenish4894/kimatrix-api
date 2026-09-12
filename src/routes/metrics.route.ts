import { Router } from "express";
import { MetricsController } from "@/controllers/MetricsController";
import { superAdminMiddleware } from "@/middleware/auth";
import { siteVisitLimiter } from "@/middleware/rateLimit";

const router = Router();
const controller = new MetricsController();

// Public and unauthenticated by design: it is called from the marketing site. The
// per-IP cap stops one client inflating the count; nothing personal is stored.
router.post("/visit", siteVisitLimiter, controller.recordVisit);

router.get("/visitors", superAdminMiddleware, controller.visitors);

export default router;
