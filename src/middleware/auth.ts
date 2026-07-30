import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError, ForbiddenError } from "@/errors/index";
import { TokenService } from "@/services/TokenService";
import { UserRepository } from "@/repositories/UserRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { computeEntitlement } from "@/utils/entitlement";

const tokenService = new TokenService();
const userRepository = new UserRepository();
const companyRepository = new CompanyRepository();

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = extractBearerToken(req);
    if (!raw) {
      throw UnauthorizedError("Authentication required");
    }

    const payload = tokenService.verifyAccessToken(raw);

    const user = await userRepository.findById(payload.sub);
    if (!user) {
      throw UnauthorizedError("User not found");
    }
    if (!user.isActive) {
      throw UnauthorizedError("Account is inactive");
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = extractBearerToken(req);
    if (!raw) {
      next();
      return;
    }
    const payload = tokenService.verifyAccessToken(raw);
    const user = await userRepository.findById(payload.sub);
    if (user && user.isActive) {
      req.user = user;
    }
    next();
  } catch {
    // Swallow — optional auth never blocks the request
    next();
  }
}

/**
 * Establishes company context. Blocks ONLY admin-deactivated accounts.
 *
 * It deliberately no longer rejects on `!company.isActive`. Expired, pending and
 * lapsed-trial companies must still reach `/company/profile`, the billing routes and
 * the data-export routes — they need to be able to pay, or to download their data and
 * leave. Gating those out here is what forced every "expired but still allowed" route
 * into a separate middleware and produced the inconsistency this replaces.
 *
 * Whether a route needs a live subscription is decided by `requireActiveSubscription`,
 * reading the `req.entitlement` attached here.
 */
export async function companyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await authMiddleware(req, res, async (err?: unknown) => {
    if (err) return next(err);
    try {
      if (!req.user) {
        throw UnauthorizedError("Authentication required");
      }
      if (req.user.userType !== "company") {
        throw ForbiddenError("Company access required");
      }
      const company = await companyRepository.findByOwnerUserId(req.user.id);
      if (!company) {
        throw ForbiddenError("Company profile not found for this user");
      }

      const entitlement = computeEntitlement(company, new Date());
      if (entitlement.status === "deactivated") {
        throw ForbiddenError("Your account has been deactivated. Please contact support.");
      }

      req.company = company;
      req.entitlement = entitlement;
      next();
    } catch (inner) {
      next(inner);
    }
  });
}

export async function superAdminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await authMiddleware(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user) return next(UnauthorizedError("Authentication required"));
    if (req.user.userType !== "super_admin") {
      return next(ForbiddenError("Super admin access required"));
    }
    next();
  });
}
