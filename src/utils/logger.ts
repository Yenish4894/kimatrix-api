import pino from "pino";
import { config, isDevelopment } from "@/config/index";

const level = (config.LOG_LEVEL ?? "info").toLowerCase();

export const logger = pino({
  level,
  base: {
    service: "sena-temp-backend",
    env: config.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "req.body.password",
      "req.body.confirmPassword",
      "req.body.currentPassword",
      "req.body.newPassword",
      "req.body.confirmNewPassword",
      "req.body.token",
      "req.body.refreshToken",
      "req.body.accessToken",
      "*.password",
      "*.confirmPassword",
      "*.currentPassword",
      "*.newPassword",
      "*.confirmNewPassword",
      "*.refreshToken",
      "*.accessToken",
      "*.tokenHash",
      "*.token_hash",
      "*.resetToken",
      // Personal data. Recipient addresses are logged as `to` by EmailService and the
      // email worker, owners as `email`/`ownerEmail`, and a Postgres unique violation
      // carries the conflicting email or mobile in `detail` (top-level, or on `err`
      // and its `driverError`). `err.parameters` is TypeORM's bound values for the
      // failed query — the same data again. Top level and one level down covers every
      // call site in src today.
      "to",
      "email",
      "ownerEmail",
      "contactEmail",
      "mobile",
      "phone",
      "contactPhone",
      "detail",
      "*.to",
      "*.email",
      "*.ownerEmail",
      "*.contactEmail",
      "*.mobile",
      "*.phone",
      "*.contactPhone",
      "*.detail",
      "err.parameters",
      "err.driverError.detail",
    ],
    censor: "[REDACTED]",
  },
  ...(isDevelopment
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss.l",
            ignore: "pid,hostname,service,env",
            singleLine: false,
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
