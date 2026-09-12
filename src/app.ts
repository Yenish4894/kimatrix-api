import "reflect-metadata";
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "@/config/index";
import { AppDataSource } from "data-source";
import { pingRedis } from "@/config/redis.client";
import { errorHandler } from "@/middleware/errorHandler";
import { httpLogger } from "@/middleware/httpLogger";
import { globalApiLimiter } from "@/middleware/rateLimit";
import { buildAllowedOrigins } from "@/utils/origins";
import routes from "@/routes/index";
import metricsRoutes from "@/routes/metrics.route";

const app: Express = express();

app.set("trust proxy", 1);

app.use(httpLogger);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  }),
);
// Both the apex and the www form — they are separate origins to a browser, and the
// site answers on both. See utils/origins.ts for what this cost us.
app.use(cors({ origin: buildAllowedOrigins(config.FRONTEND_BASE_URL), credentials: true }));
app.use(globalApiLimiter);

app.use(
  express.json({
    limit: "1mb",
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// `extended: false` (the querystring parser, not `qs`). Nothing sends nested
// urlencoded bodies — the API is JSON, uploads are multipart via multer — and `qs`'s
// nested-object parsing is attack surface we get nothing for.
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    environment: config.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.get("/ready", async (req, res) => {
  const checks: Record<string, "ok" | "fail"> = { database: "fail", redis: "fail" };
  let overallOk = true;

  try {
    await AppDataSource.query("SELECT 1");
    checks.database = "ok";
  } catch (err) {
    overallOk = false;
    req.log.error({ err }, "Readiness check: database failed");
  }

  try {
    const redisOk = await pingRedis();
    checks.redis = redisOk ? "ok" : "fail";
    if (!redisOk) overallOk = false;
  } catch (err) {
    overallOk = false;
    req.log.error({ err }, "Readiness check: redis failed");
  }

  res.status(overallOk ? 200 : 503).json({
    status: overallOk ? "ready" : "not_ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Public visit counter (POST) and the super-admin figures (GET). Auth is per route inside.
app.use("/api/metrics", metricsRoutes);
app.use("/api", routes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    error: "ROUTE_NOT_FOUND",
    timestamp: new Date().toISOString(),
  });
});

app.use(errorHandler);

export default app;
