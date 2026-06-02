import type { NextFunction, Request, Response } from "express";
import { QueryFailedError } from "typeorm";
import { isDevelopment } from "@/config/index";
import { logger } from "@/utils/logger";

export interface AppErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: AppErrorDetail[];

  constructor(
    message: string,
    statusCode = 500,
    code = "INTERNAL_ERROR",
    details?: AppErrorDetail[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    this.name = "AppError";
    Error.captureStackTrace?.(this, AppError);
  }
}

export const BadRequestError = (message = "Bad request", details?: AppErrorDetail[]) =>
  new AppError(message, 400, "BAD_REQUEST", details);

export const UnauthorizedError = (message = "Unauthorized") =>
  new AppError(message, 401, "UNAUTHORIZED");

export const ForbiddenError = (message = "Forbidden") => new AppError(message, 403, "FORBIDDEN");

export const NotFoundError = (message = "Resource not found") =>
  new AppError(message, 404, "RESOURCE_NOT_FOUND");

export const ConflictError = (message = "Resource conflict", details?: AppErrorDetail[]) =>
  new AppError(message, 409, "RESOURCE_CONFLICT", details);

export const ValidationError = (message = "Validation failed", details: AppErrorDetail[] = []) =>
  new AppError(message, 400, "VALIDATION_ERROR", details);

export const TooManyRequestsError = (message = "Too many requests") =>
  new AppError(message, 429, "RATE_LIMIT_EXCEEDED");

export const InternalError = (message = "Internal server error") =>
  new AppError(message, 500, "INTERNAL_ERROR");

const COLUMN_TO_FRIENDLY: Record<string, { field: string; message: string }> = {
  email: {
    field: "email",
    message: "This email is already registered. Try logging in instead.",
  },
  username: {
    field: "username",
    message: "This username is already taken. Please choose a different one.",
  },
  registration_number: {
    field: "registrationNumber",
    message: "This registration number is already in use by another company.",
  },
  qr_token: {
    field: "qrToken",
    message: "QR code conflict. Please try again.",
  },
  invoice_number: {
    field: "invoiceNumber",
    message: "This invoice number has already been submitted for this company.",
  },
  token_hash: {
    field: "token",
    message: "Token conflict. Please try again.",
  },
  mobile: {
    field: "mobile",
    message: "A customer with this mobile number is already on file.",
  },
};

function mapUniqueViolationToFriendly(detail: string | undefined): {
  field?: string;
  message: string;
} {
  const generic = {
    message: "Some of your details are already in use. Please review and try again.",
  };
  if (!detail) return generic;
  // Postgres detail format: `Key (col)=(value) already exists.` or `Key (col1, col2)=(v1, v2) already exists.`
  const match = /^Key \(([^)]+)\)=/.exec(detail);
  if (!match) return generic;
  const columns = match[1]!.split(",").map((c) => c.trim());
  for (const col of columns) {
    const friendly = COLUMN_TO_FRIENDLY[col];
    if (friendly) return friendly;
  }
  return generic;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const reqLogger = req.log ?? logger;
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      reqLogger.error({ err, code: err.code }, "AppError (5xx)");
    }
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      error: err.code,
      details: err.details,
      requestId,
      timestamp: new Date().toISOString(),
      ...(isDevelopment && { stack: err.stack }),
    });
    return;
  }

  if (err instanceof QueryFailedError) {
    const pgError = err as QueryFailedError & { code?: string; detail?: string };
    if (pgError.code === "23505") {
      reqLogger.warn({ pgCode: pgError.code, detail: pgError.detail }, "Unique violation (23505)");
      const friendly = mapUniqueViolationToFriendly(pgError.detail);
      res.status(409).json({
        success: false,
        message: friendly.message,
        error: "RESOURCE_CONFLICT",
        details: friendly.field
          ? [{ field: friendly.field, message: friendly.message }]
          : [{ message: friendly.message }],
        requestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    reqLogger.error({ err, pgCode: pgError.code }, "Database error");
  }

  reqLogger.error({ err }, "Unhandled error");
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: "INTERNAL_ERROR",
    requestId,
    timestamp: new Date().toISOString(),
    ...(isDevelopment && { stack: err.stack }),
  });
}
