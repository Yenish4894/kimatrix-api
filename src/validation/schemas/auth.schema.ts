import Joi from "joi";
import { addressFields, commonPatterns } from "./common.schema";
import { BUSINESS_TYPES } from "@/entities/Company";

/**
 * NOTE ON `.strict()` — do not add it at the object level.
 *
 * In Joi, `.strict()` means "no type conversion", NOT "reject unknown keys" (unknown
 * keys are handled by the middleware's `stripUnknown`). Applied to an object it sets
 * `convert: false` for the entire subtree, which turns `.trim()` and `.lowercase()`
 * from transforms into ASSERTIONS.
 *
 * That is what it did here: `John.Doe@Gmail.com` was rejected with "email must only
 * contain lowercase characters", and any address field with a trailing space was
 * rejected too. Registration and password reset were both unusable for anyone who
 * capitalises their own email address — which is most people.
 *
 * If you need to block coercion, put `.strict()` on the individual field.
 */

export const registerCompanySchema = Joi.object({
  name: commonPatterns.name.required(),
  streetAddress: addressFields.streetAddress.required(),
  city: addressFields.city.required(),
  state: addressFields.state.required(),
  country: addressFields.country.required(),
  postalCode: addressFields.postalCode.optional(),
  registrationNumber: Joi.string().trim().min(3).max(128).required(),
  contactEmail: commonPatterns.email.required(),
  contactPhone: commonPatterns.phoneE164.required(),
  whatsappNumber: commonPatterns.phoneE164.optional().allow(null, ""),
  businessType: Joi.string()
    .valid(...BUSINESS_TYPES)
    .required(),

  username: commonPatterns.username.required(),
  email: commonPatterns.email.required(),
  password: commonPatterns.password.required(),
  confirmPassword: Joi.any()
    .valid(Joi.ref("password"))
    .required()
    .messages({ "any.only": "Passwords do not match." }),

  promoEmailOptIn: Joi.boolean().default(false),
  // `.strict()` on this ONE field, not the object. Terms acceptance is a legal record,
  // so it must be an actual boolean `true` rather than the string "true" coerced into
  // one. Everything else on this schema wants coercion — see the note below.
  termsAccepted: Joi.boolean()
    .strict()
    .valid(true)
    .required()
    .messages({ "any.only": "You must accept the terms to continue." }),
}).required();

export interface RegisterCompanyInput {
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
  businessType: (typeof BUSINESS_TYPES)[number];
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  promoEmailOptIn: boolean;
  termsAccepted: true;
}

export const loginSchema = Joi.object({
  identifier: Joi.string().trim().min(3).max(255).required().messages({
    "any.required": "identifier (email or username) is required",
  }),
  password: Joi.string().min(1).max(128).required(),
}).required();

export interface LoginInput {
  identifier: string;
  password: string;
}

export const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().trim().min(10).max(512).required(),
}).required();

export interface RefreshTokenInput {
  refreshToken: string;
}

export const passwordResetRequestSchema = Joi.object({
  email: commonPatterns.email.required(),
}).required();

export interface PasswordResetRequestInput {
  email: string;
}

export const passwordResetConfirmSchema = Joi.object({
  token: Joi.string().trim().min(20).max(256).required(),
  newPassword: commonPatterns.password.required(),
  confirmNewPassword: Joi.any()
    .valid(Joi.ref("newPassword"))
    .required()
    .messages({ "any.only": "New passwords do not match." }),
}).required();

export interface PasswordResetConfirmInput {
  token: string;
  newPassword: string;
  confirmNewPassword: string;
}

export const emailVerificationConfirmSchema = Joi.object({
  // Single generic message: this is a public endpoint and the exact rule that
  // failed is of no use to a legitimate user, who only ever pastes a whole link.
  token: Joi.string().trim().min(20).max(256).required().messages({
    "string.base": "This verification link is invalid or has expired.",
    "string.empty": "This verification link is invalid or has expired.",
    "string.min": "This verification link is invalid or has expired.",
    "string.max": "This verification link is invalid or has expired.",
    "any.required": "This verification link is invalid or has expired.",
  }),
}).required();

export interface EmailVerificationConfirmInput {
  token: string;
}

export const passwordChangeSchema = Joi.object({
  currentPassword: Joi.string().min(1).max(128).required(),
  newPassword: commonPatterns.password.required(),
  confirmNewPassword: Joi.any()
    .valid(Joi.ref("newPassword"))
    .required()
    .messages({ "any.only": "New passwords do not match." }),
}).required();

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}
