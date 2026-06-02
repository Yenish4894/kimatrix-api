import type { Request } from "express";
import rateLimit, { type Options } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { getRedisClient } from "@/config/redis.client";
import { config } from "@/config/index";

const ONE_MIN = 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

function redisStore(prefix: string): RedisStore {
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (...args: string[]) =>
      (getRedisClient() as unknown as { call: (...a: string[]) => Promise<unknown> }).call(
        ...args,
      ) as Promise<string | number>,
  });
}

interface BuildLimiterOptions {
  prefix: string;
  windowMs: number;
  limit: number;
  keyGenerator?: Options["keyGenerator"];
  skipSuccessfulRequests?: boolean;
  message: string;
}

function buildLimiter(opts: BuildLimiterOptions) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: redisStore(opts.prefix),
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
    ...(opts.skipSuccessfulRequests ? { skipSuccessfulRequests: opts.skipSuccessfulRequests } : {}),
    message: {
      success: false,
      message: opts.message,
      error: "RATE_LIMIT_EXCEEDED",
    },
  });
}

function qrSubmitKey(req: Request, windowLabel: string): string {
  const qrToken = req.params["qrToken"] ?? "unknown";
  const mobile = typeof req.body?.mobile === "string" ? req.body.mobile : "unknown";
  return `${qrToken}:${mobile}:${windowLabel}`;
}

export const globalApiLimiter = buildLimiter({
  prefix: "api_global",
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_MAX_REQUESTS,
  message: "Too many requests. Please slow down and try again shortly.",
});

export const loginLimiter = buildLimiter({
  prefix: "auth_login",
  windowMs: ONE_MIN,
  limit: 5,
  skipSuccessfulRequests: true,
  message: "Too many login attempts. Please try again in a minute.",
});

export const passwordResetRequestLimiter = buildLimiter({
  prefix: "auth_pwreset_req",
  windowMs: ONE_MIN,
  limit: 3,
  message: "Too many password reset requests. Please try again in a minute.",
});

export const passwordResetConfirmLimiter = buildLimiter({
  prefix: "auth_pwreset_confirm",
  windowMs: ONE_MIN,
  limit: 5,
  message: "Too many password reset attempts. Please try again in a minute.",
});

export const qrSubmitPerMinuteLimiter = buildLimiter({
  prefix: "qr_submit_min",
  windowMs: ONE_MIN,
  limit: config.QR_SUBMIT_RATE_PER_MINUTE,
  keyGenerator: (req) => qrSubmitKey(req, "m"),
  message: "You have reached the per-minute submission limit. Please wait a moment.",
});

export const qrSubmitPerDayLimiter = buildLimiter({
  prefix: "qr_submit_day",
  windowMs: ONE_DAY,
  limit: config.QR_SUBMIT_RATE_PER_DAY,
  keyGenerator: (req) => qrSubmitKey(req, "d"),
  message: "You have reached today's submission limit for this number. Please try again tomorrow.",
});
