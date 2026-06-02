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
