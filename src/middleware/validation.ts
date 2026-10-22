import type { NextFunction, Request, Response } from "express";
import type Joi from "joi";
import { ValidationError } from "@/middleware/errorHandler";
import { logger } from "@/utils/logger";

export enum ValidationTarget {
  BODY = "body",
  QUERY = "query",
  PARAMS = "params",
}

export function validateRequest(
  schema: Joi.Schema,
  target: ValidationTarget = ValidationTarget.BODY,
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req[target], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join("."),
        message: d.message,
      }));
      // Field names only, never the values (they can be emails, phone numbers…). A
      // 400 in the request log alone did not say which field was refused.
      logger.warn(
        { path: `${req.baseUrl}${req.path}`, fields: details.map((d) => d.field) },
        "Request validation failed",
      );
      return next(ValidationError("Validation failed", details));
    }

    req[target] = value;
    next();
  };
}
