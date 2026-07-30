import "dotenv/config";

const parseInt10 = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBool = (value: string | undefined): boolean => value === "true";

export const config = {
  NODE_ENV: process.env["NODE_ENV"] ?? "development",
  PORT: parseInt10(process.env["PORT"], 5000),
  LOG_LEVEL: process.env["LOG_LEVEL"] ?? "INFO",

  DB_HOST: process.env["DB_HOST"] ?? "localhost",
  DB_PORT: parseInt10(process.env["DB_PORT"], 5432),
  DB_USERNAME: process.env["DB_USERNAME"] ?? "postgres",
  DB_PASSWORD: process.env["DB_PASSWORD"] ?? "",
  DB_NAME: process.env["DB_NAME"] ?? "sena_temp_dev",
  DB_SSL: parseBool(process.env["DB_SSL"]),

  JWT_SECRET: process.env["JWT_SECRET"] ?? "",
  JWT_REFRESH_SECRET: process.env["JWT_REFRESH_SECRET"] ?? "",
  JWT_EXPIRES_IN: process.env["JWT_EXPIRES_IN"] ?? "24h",
  JWT_REFRESH_EXPIRES_IN: process.env["JWT_REFRESH_EXPIRES_IN"] ?? "7d",

  BCRYPT_ROUNDS: parseInt10(process.env["BCRYPT_ROUNDS"], 12),
  RATE_LIMIT_WINDOW_MS: parseInt10(process.env["RATE_LIMIT_WINDOW_MS"], 15 * 60 * 1000),
  RATE_LIMIT_MAX_REQUESTS: parseInt10(process.env["RATE_LIMIT_MAX_REQUESTS"], 100),
  PASSWORD_RESET_TTL_MIN: parseInt10(process.env["PASSWORD_RESET_TTL_MIN"], 15),

  // 24h, far longer than a password reset: this link is the very first thing a new
  // customer receives, and a short window would strand anyone who signs up and
  // checks their inbox later.
  EMAIL_VERIFICATION_TTL_MIN: parseInt10(process.env["EMAIL_VERIFICATION_TTL_MIN"], 1440),

  // Free trial length. Env-overridable so a promo can be run without a deploy.
  // The clock starts on email verification, not registration.
  TRIAL_DURATION_DAYS: parseInt10(process.env["TRIAL_DURATION_DAYS"], 4),

  REDIS_HOST: process.env["REDIS_HOST"] ?? "localhost",
  REDIS_PORT: parseInt10(process.env["REDIS_PORT"], 6379),
  REDIS_PASSWORD: process.env["REDIS_PASSWORD"] ?? "",

  QR_SUBMIT_RATE_PER_MINUTE: parseInt10(process.env["QR_SUBMIT_RATE_PER_MINUTE"], 10),
  QR_SUBMIT_RATE_PER_DAY: parseInt10(process.env["QR_SUBMIT_RATE_PER_DAY"], 50),
  QR_MIN_RESUBMIT_INTERVAL_MIN: parseInt10(process.env["QR_MIN_RESUBMIT_INTERVAL_MIN"], 15),
  MAX_INVOICE_AMOUNT: parseInt10(process.env["MAX_INVOICE_AMOUNT"], 10_000_000),

  SMTP_HOST: process.env["SMTP_HOST"] ?? "",
  SMTP_PORT: parseInt10(process.env["SMTP_PORT"], 587),
  SMTP_SECURE: parseBool(process.env["SMTP_SECURE"]),
  SMTP_USER: process.env["SMTP_USER"] ?? "",
  SMTP_PASS: process.env["SMTP_PASS"] ?? "",
  SMTP_FROM_EMAIL: process.env["SMTP_FROM_EMAIL"] ?? "",
  SMTP_FROM_NAME: process.env["SMTP_FROM_NAME"] ?? "KIMates",

  APP_BASE_URL: process.env["APP_BASE_URL"] ?? "http://localhost:5000",
  FRONTEND_BASE_URL: process.env["FRONTEND_BASE_URL"] ?? "http://localhost:5173",

  PAYPAL_CLIENT_ID: process.env["PAYPAL_CLIENT_ID"] ?? "",
  PAYPAL_CLIENT_SECRET: process.env["PAYPAL_CLIENT_SECRET"] ?? "",
  PAYPAL_MODE: (process.env["PAYPAL_MODE"] ?? "sandbox") as "sandbox" | "live",
  PAYPAL_WEBHOOK_ID: process.env["PAYPAL_WEBHOOK_ID"] ?? "",
} as const;

export type AppConfig = typeof config;

const REQUIRED_KEYS: (keyof AppConfig)[] = [
  "DB_HOST",
  "DB_USERNAME",
  "DB_NAME",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
];

export function validateConfig(): void {
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return value === undefined || value === null || value === "";
  });

  if (missing.length > 0) {
    throw new Error(`[config] Missing required environment variables: ${missing.join(", ")}`);
  }

  if (config.JWT_SECRET === config.JWT_REFRESH_SECRET) {
    throw new Error("[config] JWT_SECRET and JWT_REFRESH_SECRET must differ");
  }

  if (config.JWT_SECRET.length < 32 || config.JWT_REFRESH_SECRET.length < 32) {
    throw new Error("[config] JWT secrets must be at least 32 characters");
  }
}

export const isDevelopment = config.NODE_ENV === "development";
export const isProduction = config.NODE_ENV === "production";
export const isTest = config.NODE_ENV === "test";
