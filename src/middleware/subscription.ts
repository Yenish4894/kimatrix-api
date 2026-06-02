import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "@/errors/index";

export function requireActiveSubscription(req: Request, _res: Response, next: NextFunction): void {
  const company = req.company;
  if (!company) {
    return next(ForbiddenError("Company context missing."));
  }

  const { subscriptionExpiresAt } = company;

  // No subscription set — company was manually activated by admin (free override). Allow through.
  if (!subscriptionExpiresAt) {
    return next();
  }

  if (subscriptionExpiresAt < new Date()) {
    return next(
      ForbiddenError(
        "Your subscription has expired. Please renew your plan to continue accessing the dashboard.",
      ),
    );
  }

  next();
}
