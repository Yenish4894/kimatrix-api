import Joi from "joi";
import { commonPatterns } from "./common.schema";

/**
 * The two PayPal routes previously had NO validation at all — both controllers did
 * `req.body as { planId: string }` with nothing enforcing that shape. Sending
 * `{"planId": {"id": 1}}` reached TypeORM, which read the nested object as a relation
 * condition and threw an unhandled 500 on the payment path, reachable by any
 * authenticated company.
 */
export const createOrderSchema = Joi.object({
  planId: commonPatterns.uuid.required().messages({
    "any.required": "Choose a plan to continue.",
    "string.guid": "That plan is no longer available.",
  }),
}).required();

export const captureOrderSchema = Joi.object({
  // PayPal order IDs are short uppercase alphanumeric. Bounded to the column width
  // (varchar(64)) so an oversized value is rejected before it reaches the database.
  paypalOrderId: Joi.string()
    .trim()
    .min(6)
    .max(64)
    .pattern(/^[A-Za-z0-9-]+$/)
    .required()
    .messages({
      "any.required": "Missing payment reference.",
      "string.pattern.base": "That payment reference isn't valid.",
      "string.max": "That payment reference isn't valid.",
    }),
}).required();
