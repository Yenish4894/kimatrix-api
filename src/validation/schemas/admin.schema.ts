import Joi from "joi";
import { commonPatterns, paginationSchema } from "./common.schema";

const COMPANY_STATUS_FILTERS = ["all", "active", "inactive"] as const;
const BUSINESS_TYPE_FILTERS = ["all", "fuel_station", "shop"] as const;

export const listCompaniesQuerySchema = paginationSchema.keys({
  status: Joi.string()
    .valid(...COMPANY_STATUS_FILTERS)
    .default("all"),
  businessType: Joi.string()
    .valid(...BUSINESS_TYPE_FILTERS)
    .default("all"),
});

export interface ListCompaniesQueryInput {
  page: number;
  limit: number;
  search?: string;
  status?: (typeof COMPANY_STATUS_FILTERS)[number];
  businessType?: (typeof BUSINESS_TYPE_FILTERS)[number];
}

export const companyIdParamSchema = Joi.object({
  companyId: commonPatterns.uuid.required(),
}).required();

// ─── Plan management ───────────────────────────────────────────

const planName = Joi.string().trim().min(2).max(100).messages({
  "string.empty": "Enter a name for the plan.",
  "string.min": "The plan name is too short.",
  "string.max": "The plan name is too long.",
});

const planDescription = Joi.string().trim().max(255).allow("", null).messages({
  "string.max": "The description is too long.",
});

const planDurationDays = Joi.number().integer().min(1).max(3650).messages({
  "number.base": "Enter the plan duration in days.",
  "number.integer": "The plan duration must be a whole number of days.",
  "number.min": "The plan must run for at least one day.",
  "number.max": "The plan duration is unrealistically long.",
});

// Accepted as a string so a decimal price survives the trip without float rounding.
const planPrice = Joi.string()
  .trim()
  .pattern(/^\d{1,7}(\.\d{1,2})?$/)
  .messages({
    "string.empty": "Enter a price for the plan.",
    "string.pattern.base": "Enter a valid price, for example 249.99.",
  });

export const createPlanSchema = Joi.object({
  name: planName.required(),
  description: planDescription.optional(),
  durationDays: planDurationDays.required(),
  price: planPrice.required(),
  isPopular: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(0).max(9999).optional(),
}).required();

export interface CreatePlanBody {
  name: string;
  description?: string | null;
  durationDays: number;
  price: string;
  isPopular?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

export const updatePlanSchema = Joi.object({
  name: planName.optional(),
  description: planDescription.optional(),
  durationDays: planDurationDays.optional(),
  price: planPrice.optional(),
  isPopular: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(0).max(9999).optional(),
})
  .min(1)
  .required()
  .messages({ "object.min": "Change at least one field." });

export interface UpdatePlanBody {
  name?: string;
  description?: string | null;
  durationDays?: number;
  price?: string;
  isPopular?: boolean;
  sortOrder?: number;
}

export const planIdParamSchema = Joi.object({
  planId: commonPatterns.uuid.required(),
}).required();

export const setPlanActiveSchema = Joi.object({
  isActive: Joi.boolean().required().messages({
    "any.required": "Specify whether the plan should be available.",
  }),
}).required();

// ─── Platform settings ─────────────────────────────────────────

export const updateSettingsSchema = Joi.object({
  trialDurationDays: Joi.number().integer().min(1).max(90).optional().messages({
    "number.base": "Enter the trial length in days.",
    "number.integer": "The trial length must be a whole number of days.",
    "number.min": "The trial must run for at least one day.",
    "number.max": "The trial cannot be longer than 90 days.",
  }),
  // Case-insensitive by pattern; SettingsService uppercases and validates against the
  // supported list. (The object-level `.strict()` that originally forced this shape has
  // been removed — see the note at the top of auth.schema.ts.)
  platformCurrency: Joi.string()
    .trim()
    .pattern(/^[A-Za-z]{3}$/)
    .optional()
    .messages({
      "string.pattern.base": "Enter a valid three-letter currency code, for example ZAR.",
    }),
})
  .min(1)
  .required()
  .messages({ "object.min": "Change at least one setting." });

export interface UpdateSettingsBody {
  trialDurationDays?: number;
  platformCurrency?: string;
}
