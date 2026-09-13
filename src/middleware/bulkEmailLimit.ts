import type { Request } from "express";
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { getRedisClient } from "@/config/redis.client";

/**
 * Caps how often one admin can fire a bulk email (SEC-7).
 *
 * Each send enqueues one job per recipient through our only mailbox. A double-click, a
 * retry loop in a script, or a stolen admin session could push thousands of messages
 * through Hostinger in minutes — exactly the pattern that gets a mailbox suspended, and
 * a suspended mailbox takes password resets and receipts down with it.
 *
 * Keyed on the admin's user id (this runs after superAdminMiddleware), so a shared
 * office IP does not throttle a second admin. Mounted BEFORE the upload middleware, so
 * a refused request never writes its attachment to disk.
 *
 * Lives here rather than in rateLimit.ts only to keep that file's ownership separate;
 * the store and fail-open behaviour match its limiters.
 */
export const BULK_EMAIL_SENDS_PER_HOUR = 5;

export const bulkEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: BULK_EMAIL_SENDS_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    prefix: "rl:admin_bulk_email:",
    sendCommand: (...args: string[]) =>
      (getRedisClient() as unknown as { call: (...a: string[]) => Promise<unknown> }).call(
        ...args,
      ) as Promise<string | number>,
  }),
  // Fail open, like every other limiter: a Redis blip must not turn into a 500.
  passOnStoreError: true,
  keyGenerator: (req: Request) => `user:${req.user?.id ?? "unknown"}`,
  message: {
    success: false,
    message: `You can send at most ${BULK_EMAIL_SENDS_PER_HOUR} bulk emails an hour. Please try again later.`,
    error: "RATE_LIMIT_EXCEEDED",
  },
});
