import type { NextFunction, Request, Response } from "express";
import type Joi from "joi";
import { ValidationError } from "@/middleware/errorHandler";

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
      return next(ValidationError("Validation failed", details));
    }

    req[target] = value;
    next();
  };
}
