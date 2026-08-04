import Joi from "joi";

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

export const commonPatterns = {
  uuid: Joi.string().uuid({ version: "uuidv4" }),
  email: Joi.string().trim().lowercase().email().max(255),
  username: Joi.string()
    .trim()
    .min(3)
    .max(64)
    .pattern(/^[a-zA-Z0-9_.-]+$/)
    .message("Username may only contain letters, digits, dot, underscore, or hyphen."),
  password: Joi.string()
    .min(8)
    .max(18)
    .pattern(PASSWORD_PATTERN)
    .message(
      "Password must be 8–18 characters and include one lowercase letter, one uppercase letter, one number, and one special character.",
    ),
  phoneE164: Joi.string()
    .trim()
    .pattern(E164_PATTERN)
    .message("Please enter a valid phone number in international format, e.g. +22712345678."),
  name: Joi.string().trim().min(2).max(255),
  positiveInt: Joi.number().integer().positive(),
  shortText: Joi.string().trim().max(255),
  longText: Joi.string().trim().max(2048),
};

export const addressFields = {
  streetAddress: Joi.string().trim().min(3).max(512).messages({
    "string.empty": "Street address is required.",
    "string.min": "Street address must be at least 3 characters.",
    "string.max": "Street address must be 512 characters or fewer.",
    "any.required": "Street address is required.",
  }),
  city: Joi.string().trim().min(2).max(128).messages({
    "string.empty": "City is required.",
    "string.min": "City must be at least 2 characters.",
    "string.max": "City must be 128 characters or fewer.",
    "any.required": "City is required.",
  }),
  state: Joi.string().trim().min(2).max(128).messages({
    "string.empty": "State or region is required.",
    "string.min": "State or region must be at least 2 characters.",
    "string.max": "State or region must be 128 characters or fewer.",
    "any.required": "State or region is required.",
  }),
  country: Joi.string().trim().min(2).max(128).messages({
    "string.empty": "Country is required.",
    "string.min": "Country must be at least 2 characters.",
    "string.max": "Country must be 128 characters or fewer.",
    "any.required": "Country is required.",
  }),
  postalCode: Joi.string().trim().min(1).max(32).allow(null, "").messages({
    "string.min": "Postal code must be at least 1 character.",
    "string.max": "Postal code must be 32 characters or fewer.",
  }),
};

export const idParamsSchema = Joi.object({
  id: commonPatterns.uuid.required(),
}).required();

export const paginationSchema = Joi.object({
  // Bounded: `?page=999999999` becomes OFFSET 9999999980 on a joined
  // getManyAndCount, holding a pool connection while Postgres walks and discards the
  // entire index.
  page: commonPatterns.positiveInt.max(10_000).default(1),
  limit: commonPatterns.positiveInt.max(100).default(10),
  search: Joi.string().trim().max(255).allow(""),
});
