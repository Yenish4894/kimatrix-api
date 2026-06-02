import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError, ForbiddenError } from "@/errors/index";
import { TokenService } from "@/services/TokenService";
import { UserRepository } from "@/repositories/UserRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";

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
      if (!company.isActive) {
        throw ForbiddenError("Company account is deactivated");
      }
      req.company = company;
      next();
    } catch (inner) {
      next(inner);
    }
  });
}

// Used by payment routes — allows pending (isActive=false, deactivatedAt=null) and active companies.
// Deactivated companies are still blocked.
export async function billingCompanyMiddleware(
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
      if (!company.isActive && company.deactivatedAt != null) {
        throw ForbiddenError("Company account is deactivated");
      }
      req.company = company;
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
