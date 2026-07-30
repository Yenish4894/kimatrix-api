import type { NextFunction, Request, Response } from "express";
import { ForbiddenError, SubscriptionRequiredError } from "@/errors/index";

/**
 * Gates routes that require a live entitlement (paid, trialing, or comped).
 *
 * `req.entitlement` is computed fresh by companyMiddleware on every request —
 * this never reads `companies.subscription_status`, which is only a projection
 * maintained by the expiry cron. That separation means a stalled cron or a clock
 * skew cannot lock out a customer who has actually paid.
 *
 * Note what is NOT here any more: the old `if (!subscriptionExpiresAt) return next()`
 * branch, which silently granted unlimited access to any company with a null expiry
 * and directly contradicted the frontend gate. That override is now explicit
 * (`companies.is_comped`) and is resolved inside computeEntitlement().
 */
export function requireActiveSubscription(req: Request, _res: Response, next: NextFunction): void {
  const entitlement = req.entitlement;
  if (!entitlement) {
    // companyMiddleware always sets this; reaching here means the router is misconfigured.
    return next(ForbiddenError("Company context missing."));
  }

  if (!entitlement.hasAccess) {
    return next(
      SubscriptionRequiredError(undefined, [
        { field: "subscriptionStatus", message: entitlement.status },
      ]),
    );
  }

  next();
}

/**
 * Gates the data-export routes. Deliberately a positive assertion rather than the
 * mere absence of `requireActiveSubscription`: export must keep working after a
 * subscription lapses (that is the whole "download your data and leave" path), and
 * someone will eventually add a blanket `router.use(requireActiveSubscription)` to
 * the company router. This makes that break loudly instead of silently.
 */
export function requireExportAllowed(req: Request, _res: Response, next: NextFunction): void {
  const entitlement = req.entitlement;
  if (!entitlement) {
    return next(ForbiddenError("Company context missing."));
  }

  if (!entitlement.canExport) {
    return next(ForbiddenError("Your account has been deactivated. Please contact support."));
  }

  next();
}
