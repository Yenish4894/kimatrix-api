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
})
  .strict()
  .required();
