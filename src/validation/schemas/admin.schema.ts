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

// ─── Subscription / trial administration ────────────────────────────────────

export const extendTrialSchema = Joi.object({
  // Bounded at a year. An unbounded value is a typo away from a perpetual free
  // account, and a perpetual free account is what `isComped` is for — it is explicit,
  // it records who granted it and why, and it shows up in the comp report.
  days: Joi.number().integer().min(1).max(365).required().messages({
    "number.max":
      "Grant at most 365 days. For permanent free access, use complimentary access instead.",
    "any.required": "How many days should the trial run for?",
  }),
});

export const setCompSchema = Joi.object({
  isComped: Joi.boolean().strict().required(),
  // Required when granting, ignored when revoking. Enforced here AND in the service:
  // the service is the one that runs for any future caller that skips this schema.
  reason: Joi.string()
    .trim()
    .max(255)
    .when("isComped", {
      is: true,
      then: Joi.required().messages({
        "any.required": "Please give a reason for this complimentary access.",
        "string.empty": "Please give a reason for this complimentary access.",
      }),
      otherwise: Joi.optional().allow(null, ""),
    }),
  // Null means perpetual. Deliberately allowed — some accounts genuinely are free
  // forever — but it is the caller's explicit choice, never a default.
  compedUntil: Joi.date().iso().greater("now").allow(null).optional().messages({
    "date.greater": "Choose a date in the future.",
  }),
});

export const releaseTrialIdentitySchema = Joi.object({
  reason: Joi.string().trim().min(3).max(255).required().messages({
    "any.required": "Please give a reason for releasing this identifier.",
    "string.empty": "Please give a reason for releasing this identifier.",
  }),
});

export const trialIdentityIdParamSchema = Joi.object({
  identityId: commonPatterns.uuid.required(),
});

export interface ExtendTrialInput {
  days: number;
}

export interface SetCompInput {
  isComped: boolean;
  reason?: string | null;
  compedUntil?: Date | null;
}

export interface ReleaseTrialIdentityInput {
  reason: string;
}

/**
 * Deletion actioned on a customer's behalf. The reason is REQUIRED — a request that
 * arrived by email has no other record that it was ever made.
 */
export const adminDeletionSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(255).required().messages({
    "any.required": "Record who asked for this and how.",
    "string.empty": "Record who asked for this and how.",
    "string.min": "Record who asked for this and how.",
  }),
});

export interface AdminDeletionInput {
  reason: string;
}

// ─── Bulk email ───────────────────────────────────────────────────────────

export const sendBulkEmailSchema = Joi.object({
  subject: Joi.string().trim().min(1).max(255).required().messages({
    "any.required": "Subject is required.",
    "string.empty": "Subject is required.",
    "string.max": "Subject must be 255 characters or fewer.",
  }),
  body: Joi.string().trim().min(1).max(10000).required().messages({
    "any.required": "Body is required.",
    "string.empty": "Body is required.",
    "string.max": "Body must be 10,000 characters or fewer.",
  }),
  // `.items(uuid)` without `.required()` inside: marking the item required makes Joi
  // emit its own "does not contain 1 required value(s)" for an empty array, which
  // reached the user verbatim and overrode the copy below.
  //
  // No longer `.min(1)`: a send can now go to typed-in addresses alone, with no
  // company selected at all. The "somebody must receive this" rule moved to the
  // object-level check below, because neither array can enforce it by itself.
  companyIds: Joi.array().items(commonPatterns.uuid).default([]).messages({
    "array.base": "Select at least one company.",
  }),
  // Addresses typed in by hand — people who are not registered companies. Capped
  // because this is a comma-separated box, and a paste of a thousand addresses is a
  // mistake far more often than an intention.
  extraEmails: Joi.array()
    .items(Joi.string().trim().lowercase().email({ tlds: false }).max(255))
    .max(50)
    .default([])
    .messages({
      "string.email": "One of the extra addresses isn't a valid email.",
      "array.max": "You can add up to 50 extra addresses at a time.",
      "array.base": "Extra addresses must be a list.",
    }),
})
  .required()
  // Enforced here rather than on either array: each one is individually optional, but
  // sending to nobody is not a thing anyone means to do.
  .custom((value, helpers) => {
    const { companyIds, extraEmails } = value as SendBulkEmailInput;
    if (companyIds.length === 0 && extraEmails.length === 0) {
      return helpers.error("any.custom");
    }
    return value;
  })
  .messages({
    "any.custom": "Select at least one company, or add an email address.",
  });

export interface SendBulkEmailInput {
  subject: string;
  body: string;
  companyIds: string[];
  extraEmails: string[];
}
