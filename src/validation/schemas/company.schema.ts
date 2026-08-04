import Joi from "joi";
import { addressFields, commonPatterns, paginationSchema } from "./common.schema";

const SORT_ORDER = ["ASC", "DESC"] as const;
const CUSTOMER_SORT_FIELDS = [
  "totalInvoiceAmount",
  "submissionCount",
  "lastSubmissionAt",
  "firstSubmissionAt",
] as const;
const PURCHASE_SORT_FIELDS = ["submittedAt", "invoiceAmount"] as const;

export const listCustomersQuerySchema = paginationSchema.keys({
  sortBy: Joi.string()
    .valid(...CUSTOMER_SORT_FIELDS)
    .default("totalInvoiceAmount"),
  sortOrder: Joi.string()
    .valid(...SORT_ORDER)
    .default("DESC"),
});

export interface ListCustomersQueryInput {
  page: number;
  limit: number;
  search?: string;
  sortBy?: (typeof CUSTOMER_SORT_FIELDS)[number];
  sortOrder?: (typeof SORT_ORDER)[number];
}

export const listPurchasesQuerySchema = paginationSchema.keys({
  customerId: commonPatterns.uuid.optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date()
    .iso()
    .optional()
    .when("from", {
      is: Joi.exist(),
      then: Joi.date().iso().min(Joi.ref("from")),
    }),
  sortBy: Joi.string()
    .valid(...PURCHASE_SORT_FIELDS)
    .default("submittedAt"),
  sortOrder: Joi.string()
    .valid(...SORT_ORDER)
    .default("DESC"),
});

export interface ListPurchasesQueryInput {
  page: number;
  limit: number;
  search?: string;
  customerId?: string;
  from?: Date;
  to?: Date;
  sortBy?: (typeof PURCHASE_SORT_FIELDS)[number];
  sortOrder?: (typeof SORT_ORDER)[number];
}

export const updateProfileSchema = Joi.object({
  streetAddress: addressFields.streetAddress.optional(),
  city: addressFields.city.optional(),
  state: addressFields.state.optional(),
  country: addressFields.country.optional(),
  postalCode: addressFields.postalCode.optional(),
  contactEmail: commonPatterns.email.optional(),
  contactPhone: commonPatterns.phoneE164.optional(),
  whatsappNumber: commonPatterns.phoneE164.optional().allow(null, ""),
  promoEmailOptIn: Joi.boolean().optional(),
})
  .min(1)
  .required();

export interface UpdateProfileInput {
  streetAddress?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string | null;
  contactEmail?: string;
  contactPhone?: string;
  whatsappNumber?: string | null;
  promoEmailOptIn?: boolean;
}

export const customerIdParamSchema = Joi.object({
  customerId: commonPatterns.uuid.required(),
}).required();

export const purchaseIdParamSchema = Joi.object({
  purchaseId: commonPatterns.uuid.required(),
}).required();

/**
 * `format` only. No pagination: a bulk export is deliberately exempt (see
 * be-endpoints.md), because a customer taking their data must get all of it, and
 * paginating would turn "download and leave" into a scripted loop.
 */
export const exportQuerySchema = Joi.object({
  format: Joi.string().valid("csv", "json").default("csv").messages({
    "any.only": "Choose either CSV or JSON.",
  }),
});

export interface ExportQueryInput {
  format: "csv" | "json";
}
