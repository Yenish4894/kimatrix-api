import Joi from "joi";
import { addressFields, commonPatterns, paginationSchema } from "./common.schema";

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
  drawSpins: Joi.number().integer().min(0).max(100).optional().messages({
    "number.max": "A plan can include at most 100 lucky draw spins.",
    "number.min": "Lucky draw spins can't be negative.",
  }),
}).required();

export interface CreatePlanBody {
  name: string;
  description?: string | null;
  durationDays: number;
  price: string;
  isPopular?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  drawSpins?: number;
}

export const updatePlanSchema = Joi.object({
  name: planName.optional(),
  description: planDescription.optional(),
  durationDays: planDurationDays.optional(),
  price: planPrice.optional(),
  isPopular: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(0).max(9999).optional(),
  drawSpins: Joi.number().integer().min(0).max(100).optional().messages({
    "number.max": "A plan can include at most 100 lucky draw spins.",
    "number.min": "Lucky draw spins can't be negative.",
  }),
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
  drawSpins?: number;
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
  spinAddonPriceUsd: Joi.number().positive().max(100).precision(2).optional().messages({
    "number.base": "Enter a price for the spin add-on.",
    "number.positive": "The spin price must be greater than zero.",
    "number.max": "The spin price cannot exceed USD 100.",
  }),
  trialDrawSpins: Joi.number().integer().min(0).max(100).optional().messages({
    "number.base": "Enter how many spins a trial gets.",
    "number.integer": "Trial spins must be a whole number.",
    "number.min": "Trial spins cannot be negative.",
    "number.max": "A trial can get at most 100 spins.",
  }),
})
  .min(1)
  .required()
  .messages({ "object.min": "Change at least one setting." });

export interface UpdateSettingsBody {
  trialDurationDays?: number;
  platformCurrency?: string;
  spinAddonPriceUsd?: number;
  trialDrawSpins?: number;
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
  drawSpins: Joi.number().integer().min(0).max(100).optional(),
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
  // Required when granting — the comment above always said perpetual must be the
  // caller's explicit choice, but an omitted field used to fall through to null and so
  // silently granted free access forever.
  compedUntil: Joi.date()
    .iso()
    .greater("now")
    .allow(null)
    .when("isComped", { is: true, then: Joi.required(), otherwise: Joi.optional() })
    .messages({
      "date.greater": "Choose a date in the future.",
      "any.required": "Choose an end date, or explicitly choose no end date.",
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
  drawSpins?: number;
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
/**
 * Banning demands a stated reason.
 *
 * Not bureaucracy: a ban revokes the owner’s sessions, cancels their billing, blocks
 * login and withholds their data export. One was issued by a misclick 144 seconds after
 * the same admin extended that company’s trial, and because nothing recorded a reason
 * it took a dig through three days of log files to establish what had even happened.
 * Requiring a sentence also puts a deliberate pause in front of the most destructive
 * button on the screen.
 */
/**
 * Onboarding a company from the admin side.
 *
 * The business fields mirror public registration so both paths produce identical rows.
 * What is absent matters as much: no password (the owner sets their own from an emailed
 * link, so an operator never handles a customer's credential), no username (nothing to
 * collide on and no name for an admin to invent), and no terms checkbox — the operator
 * is accepting on the customer's behalf and the record says so.
 */
export const createCompanySchema = Joi.object({
  name: commonPatterns.name.required(),
  streetAddress: addressFields.streetAddress.required(),
  city: addressFields.city.required(),
  state: addressFields.state.required(),
  country: addressFields.country.required(),
  postalCode: addressFields.postalCode.optional().allow(null, ""),
  registrationNumber: Joi.string().trim().min(3).max(128).required(),
  contactEmail: commonPatterns.email.required(),
  contactPhone: commonPatterns.phoneE164.required(),
  whatsappNumber: commonPatterns.phoneE164.optional().allow(null, ""),
  businessType: Joi.string().valid("fuel_station", "shop").required(),
  email: commonPatterns.email.required().messages({
    "any.required": "The owner's login email is required — the invite is sent there.",
  }),
  // null = complimentary access with no end date. Allowed, but the form defaults to a
  // date so that free access resurfaces for a decision rather than becoming permanent
  // by omission.
  compedUntil: Joi.date().iso().greater("now").required().allow(null).messages({
    "date.greater": "The free-access date must be in the future.",
  }),
  compReason: Joi.string().trim().min(3).max(255).required().messages({
    "any.required": "Record why this company is being given free access.",
    "string.empty": "Record why this company is being given free access.",
    "string.min": "Record why this company is being given free access.",
  }),
  compDrawSpins: Joi.number().integer().min(0).max(100).optional(),
});

export interface CreateCompanyInput {
  name: string;
  streetAddress: string;
  city: string;
  state: string;
  country: string;
  postalCode?: string | null;
  registrationNumber: string;
  contactEmail: string;
  contactPhone: string;
  whatsappNumber?: string | null;
  businessType: "fuel_station" | "shop";
  email: string;
  compedUntil: string | null;
  compReason: string;
  compDrawSpins?: number;
}

export const companyBanSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(255).required().messages({
    "any.required": "Say why this company is being banned.",
    "string.empty": "Say why this company is being banned.",
    "string.min": "Say why this company is being banned.",
    "string.max": "Keep the reason under 255 characters.",
  }),
});

export interface CompanyBanInput {
  reason: string;
}

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
