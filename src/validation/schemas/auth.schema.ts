import Joi from "joi";
import { addressFields, commonPatterns } from "./common.schema";
import { BUSINESS_TYPES } from "@/entities/Company";

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
  termsAccepted: Joi.boolean()
    .valid(true)
    .required()
    .messages({ "any.only": "You must accept the terms to continue." }),
})
  .strict()
  .required();

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
})
  .strict()
  .required();

export interface LoginInput {
  identifier: string;
  password: string;
}

export const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().trim().min(10).max(512).required(),
})
  .strict()
  .required();

export interface RefreshTokenInput {
  refreshToken: string;
}

export const passwordResetRequestSchema = Joi.object({
  email: commonPatterns.email.required(),
})
  .strict()
  .required();

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
})
  .strict()
  .required();

export interface PasswordResetConfirmInput {
  token: string;
  newPassword: string;
  confirmNewPassword: string;
}

export const passwordChangeSchema = Joi.object({
  currentPassword: Joi.string().min(1).max(128).required(),
  newPassword: commonPatterns.password.required(),
  confirmNewPassword: Joi.any()
    .valid(Joi.ref("newPassword"))
    .required()
    .messages({ "any.only": "New passwords do not match." }),
})
  .strict()
  .required();

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}
