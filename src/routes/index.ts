import { Router } from "express";
import authRoutes from "@/routes/auth.route";
import companyRoutes from "@/routes/company.route";
import adminRoutes from "@/routes/admin.route";
import qrRoutes from "@/routes/qr.route";
import paymentRoutes from "@/routes/payment.route";

const router = Router();

router.use("/auth", authRoutes);
router.use("/company", companyRoutes);
router.use("/admin", adminRoutes);
router.use("/qr", qrRoutes);
router.use("/payments", paymentRoutes);

export default router;
