import Joi from "joi";
import { commonPatterns } from "./common.schema";
import { config } from "@/config/index";

export const qrTokenParamSchema = Joi.object({
  qrToken: Joi.string()
    .trim()
    .min(16)
    .max(64)
    .pattern(/^[A-Za-z0-9_-]+$/)
    .required()
    .messages({
      "string.empty": "QR code is invalid or missing.",
      "string.min": "QR code is invalid.",
      "string.max": "QR code is invalid.",
      "string.pattern.base": "QR code is invalid.",
      "any.required": "QR code is invalid or missing.",
    }),
}).required();

export const submitPurchaseSchema = Joi.object({
  mobile: commonPatterns.phoneE164.required(),
  fullName: commonPatterns.name.required(),
  vehicleNumber: Joi.string()
    .trim()
    .min(2)
    .max(32)
    .pattern(/^[A-Za-z0-9-]+$/)
    .optional(),
  invoiceNumber: Joi.string().trim().min(1).max(64).required(),
  invoiceAmount: Joi.number().positive().precision(2).max(config.MAX_INVOICE_AMOUNT).required(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  locationAccuracy: Joi.number().min(0).max(100_000_000).optional(),
}).required();

export interface SubmitPurchaseInput {
  mobile: string;
  fullName: string;
  vehicleNumber?: string;
  invoiceNumber: string;
  invoiceAmount: number;
  latitude?: number;
  longitude?: number;
  locationAccuracy?: number;
}
