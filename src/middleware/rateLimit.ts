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
    // Fail OPEN on a store error. The default is false, which routes a Redis failure
    // to next(error) — and since globalApiLimiter fronts all of /api, any Redis blip
    // (failover, restart, exhausted retry budget) turned EVERY request into a 500,
    // including the PayPal webhook and the public QR endpoint. That makes a cache a
    // hard availability dependency on the money path.
    //
    // Losing rate limiting for the seconds Redis is unavailable is strictly better
    // than losing the application. The failure is logged by the store's own handler.
    passOnStoreError: true,
    ...(opts.keyGenerator ? { keyGenerator: opts.keyGenerator } : {}),
    ...(opts.skipSuccessfulRequests ? { skipSuccessfulRequests: opts.skipSuccessfulRequests } : {}),
    message: {
      success: false,
      message: opts.message,
      error: "RATE_LIMIT_EXCEEDED",
    },
  });
}

/**
 * Normalise a client IP for use in a rate-limit key.
 *
 * IPv6 is collapsed to its /64 prefix: a single residential allocation is a /64 or
 * larger, so keying on the full address lets one connection rotate through billions of
 * distinct keys. IPv4 is used whole. (`express-rate-limit` 7.5.1 does not export its
 * own `ipKeyGenerator`, hence the local implementation.)
 */
function ipKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const addr = ip.startsWith("::ffff:") ? ip.slice(7) : ip; // unwrap IPv4-mapped IPv6
  if (!addr.includes(":")) return addr;
  return `${addr.split(":").slice(0, 4).join(":")}::/64`;
}

/**
 * Keyed on IP + token + mobile.
 *
 * The IP component is the important part. A custom `keyGenerator` REPLACES the default
 * IP key entirely, so bucketing on `qrToken:mobile` alone meant an attacker only had to
 * increment the phone number on each request to get a fresh bucket — defeating both
 * QR limiters and the service-layer resubmit cooldown, which is also mobile-keyed.
 *
 * The only remaining brake was the global 100-per-15-min IP cap, i.e. roughly 400
 * forged purchases an hour, each creating a customer row and inflating that company's
 * total spend. This is the one unauthenticated write path in the system and there is no
 * delete path, so the corruption is permanent.
 *
 * `ipKey` is used rather than raw `req.ip` because it normalises IPv6 to a /64 subnet —
 * a bare IPv6 address is trivially rotated within a single allocation.
 */
function qrSubmitKey(req: Request, windowLabel: string): string {
  const qrToken = req.params["qrToken"] ?? "unknown";
  const mobile = typeof req.body?.mobile === "string" ? req.body.mobile : "unknown";
  return `${ipKey(req.ip)}:${qrToken}:${mobile}:${windowLabel}`;
}

/**
 * Companion cap with NO mobile component, so rotating the phone number cannot escape
 * it. Bounds how many submissions one device can make against one merchant per day,
 * whatever identity it claims.
 */
export const qrSubmitPerDevicePerDayLimiter = buildLimiter({
  prefix: "qr_submit_device_day",
  windowMs: ONE_DAY,
  limit: 30,
  keyGenerator: (req: Request) =>
    `${ipKey(req.ip)}:${req.params["qrToken"] ?? "unknown"}:device_day`,
  message: "Too many submissions from this device today. Please try again tomorrow.",
});

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

// Registration had no limiter at all — only the 100-per-15-min global cap. It now
// sends a verification email and (from Phase 3) dispenses a free trial, so it is
// both a spam vector and a value-dispensing endpoint.
//
// Deliberately NOT skipSuccessfulRequests (unlike loginLimiter): successful
// registrations are precisely what we are limiting.
export const registerLimiter = buildLimiter({
  prefix: "auth_register",
  windowMs: ONE_MIN * 60,
  limit: 5,
  message: "Too many registration attempts from this network. Please try again later.",
});

// Resend is authenticated, but still capped: each call sends a real email, so an
// uncapped endpoint is a spam amplifier pointed at the user's own inbox.
export const emailVerificationResendLimiter = buildLimiter({
  prefix: "auth_verify_resend",
  windowMs: ONE_MIN * 10,
  limit: 3,
  message: "Too many verification emails requested. Please try again in a few minutes.",
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
