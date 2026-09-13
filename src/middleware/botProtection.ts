import type { NextFunction, Request, Response } from "express";
import { config } from "@/config/index";
import { BadRequestError } from "@/errors/index";
import { logger } from "@/utils/logger";
import { verifyTurnstileToken } from "@/utils/turnstile";

/**
 * Deliberately vague. Telling a bot "the website field must be empty" teaches its
 * author to leave it empty; telling it nothing costs a real person nothing, because a
 * real person never sees the field.
 */
export const HONEYPOT_REJECTION = "Registration could not be completed.";
export const HUMAN_CHECK_FAILED = "Could not verify you're human, please try again.";
const HUMAN_CHECK_MISSING = "Please complete the human verification and try again.";

/**
 * Signup honeypot: `website` is rendered off-screen by the frontend, so any value in it
 * came from something filling every input it could find.
 *
 * Runs BEFORE Joi. If Joi went first, a bot would get the full field-by-field error
 * list — a free map of what to fix — before ever reaching this check. Any value other
 * than absent/empty trips it; trimming is not done because a human cannot type into a
 * field they cannot see, so even whitespace is a bot signal.
 */
export function rejectHoneypot(req: Request, _res: Response, next: NextFunction): void {
  const value = (req.body as Record<string, unknown> | undefined)?.["website"];
  if (value === undefined || value === null || value === "") return next();

  // No body fields logged: whatever a bot typed is noise, and the email it used might
  // be a real stranger's address.
  logger.warn(
    { ip: req.ip, userAgent: req.get("user-agent") ?? null, path: req.originalUrl },
    "Registration honeypot tripped — rejected",
  );
  next(BadRequestError(HONEYPOT_REJECTION));
}

/**
 * Cloudflare Turnstile gate, feature-flagged on TURNSTILE_SECRET_KEY.
 *
 * Unset → skipped entirely, so the site keeps working until the client supplies keys.
 * Set → fail CLOSED: no token, a bad token, or Cloudflare being unreachable all refuse
 * the signup. Failing open when the key is configured would make the whole check
 * defeatable by anyone who can make our outbound call slow.
 *
 * Runs AFTER Joi so an ordinary form mistake does not burn the single-use token.
 */
export function requireTurnstile(req: Request, _res: Response, next: NextFunction): void {
  const secret = config.TURNSTILE_SECRET_KEY;
  if (!secret) return next();

  const raw = (req.body as Record<string, unknown> | undefined)?.["turnstileToken"];
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token) {
    return next(
      BadRequestError(HUMAN_CHECK_MISSING, [
        { field: "turnstileToken", message: HUMAN_CHECK_MISSING },
      ]),
    );
  }

  verifyTurnstileToken(token, req.ip, secret)
    .then((verdict) => {
      if (verdict.ok) return next();
      logger.warn(
        { ip: req.ip, reason: verdict.reason, errorCodes: verdict.errorCodes },
        verdict.reason === "unreachable"
          ? "Turnstile verification unreachable — registration refused (fail closed)"
          : "Turnstile verification rejected — registration refused",
      );
      next(
        BadRequestError(HUMAN_CHECK_FAILED, [
          { field: "turnstileToken", message: HUMAN_CHECK_FAILED },
        ]),
      );
    })
    // verifyTurnstileToken never rejects; this only guards a bug in the handler above.
    .catch(next);
}
