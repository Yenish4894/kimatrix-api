import crypto from "node:crypto";
import pinoHttp from "pino-http";
import { logger } from "@/utils/logger";

const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

/**
 * The path only, never the query string. Admin list endpoints take `?search=` with a
 * customer's name, email or mobile, and every request line went to the logs verbatim.
 */
const pathOnly = (url: string | undefined): string => (url ?? "").split("?")[0] ?? "";

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
        url: pathOnly(req.url),
        remoteAddress: req.remoteAddress,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
  customSuccessMessage: (req, res) => `${req.method} ${pathOnly(req.url)} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${pathOnly(req.url)} ${res.statusCode} ${err.message}`,
});
