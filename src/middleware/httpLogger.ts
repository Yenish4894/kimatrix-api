import crypto from "node:crypto";
import pinoHttp from "pino-http";
import { logger } from "@/utils/logger";

const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers["x-request-id"];
    const candidate = typeof incoming === "string" ? incoming : undefined;
    const id = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : crypto.randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
});
