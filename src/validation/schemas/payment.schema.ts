import Joi from "joi";
import { commonPatterns, paginationSchema } from "./common.schema";
import { PAYMENT_KINDS, type PaymentKind } from "@/entities/Payment";

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
  spinQuantity: Joi.number().integer().min(0).max(100).default(0),
}).required();

export const createSpinOrderSchema = Joi.object({
  spinQuantity: Joi.number().integer().min(1).max(100).required().messages({
    "any.required": "Choose how many spins to add.",
    "number.min": "Choose at least one spin.",
  }),
}).required();

export interface CreateOrderInput {
  planId: string;
  spinQuantity: number;
}

export interface CreateSpinOrderInput {
  spinQuantity: number;
}

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

// ─── Subscriptions (Phase 6) ────────────────────────────────────────────────

export const subscribeSchema = Joi.object({
  planId: commonPatterns.uuid.required().messages({
    "any.required": "Choose a plan to continue.",
    "string.guid": "That plan is no longer available.",
  }),
}).required();

export const confirmSubscriptionSchema = Joi.object({
  // PayPal subscription ids look like I-BW452GLLEP1G.
  paypalSubscriptionId: Joi.string()
    .trim()
    .min(6)
    .max(64)
    .pattern(/^[A-Za-z0-9-]+$/)
    .required()
    .messages({
      "any.required": "Missing subscription reference.",
      "string.pattern.base": "That subscription reference isn't valid.",
    }),
}).required();

export const cancelSubscriptionSchema = Joi.object({
  // Asked for, not required: making someone justify leaving is a dark pattern, and a
  // blank reason is more honest than a forced one.
  reason: Joi.string().trim().max(255).allow("").default("Cancelled by customer"),
}).required();

export const changePlanSchema = Joi.object({
  planId: commonPatterns.uuid.required().messages({
    "any.required": "Choose the plan you want to move to.",
  }),
}).required();

// ─── Payment history and invoices ───────────────────────────────────────────

export const paymentIdParamSchema = Joi.object({
  paymentId: commonPatterns.uuid.required(),
}).required();

/** Company history: page and limit only. `search` is inherited but unused. */
export const listCompanyPaymentsQuerySchema = paginationSchema;

const ADMIN_PAYMENT_STATUS_FILTERS = [
  "captured",
  "refunded",
  "pending",
  "capturing",
  "failed",
] as const;

export const listAdminPaymentsQuerySchema = paginationSchema.keys({
  // No default: the admin ledger shows every row unless asked to narrow it.
  status: Joi.string()
    .valid(...ADMIN_PAYMENT_STATUS_FILTERS)
    .optional(),
  kind: Joi.string()
    .valid(...PAYMENT_KINDS)
    .optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date()
    .iso()
    .optional()
    .when("from", { is: Joi.exist(), then: Joi.date().iso().min(Joi.ref("from")) }),
});

export interface ListAdminPaymentsQueryInput {
  page: number;
  limit: number;
  search?: string;
  status?: (typeof ADMIN_PAYMENT_STATUS_FILTERS)[number];
  kind?: PaymentKind;
  from?: Date;
  to?: Date;
}

export const systemStatusQuerySchema = Joi.object({
  refresh: Joi.boolean().truthy("1").falsy("0").default(false),
});

export interface SubscribeInput {
  planId: string;
}
export interface ConfirmSubscriptionInput {
  paypalSubscriptionId: string;
}
export interface CancelSubscriptionInput {
  reason: string;
}
export interface ChangePlanInput {
  planId: string;
}
