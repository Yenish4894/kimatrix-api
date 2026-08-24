import type { NextFunction, Request, Response } from "express";

/**
 * Turns the multipart form fields back into the shapes the validator expects.
 *
 * A multipart body is all strings — there is no way for a form field to carry a JSON
 * array. `companyIds` and `extraEmails` arrive either as a repeated field (an array
 * already) or as a single JSON string, depending on how many values there were.
 *
 * Without this the request still validates as "select at least one company" even when
 * the admin had fifty selected, because the validator sees a string where it wants an
 * array. The send would fail with a message describing something the admin did not do.
 */
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];

  // The client sends JSON so one id and fifty ids look the same on this side.
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Not JSON — fall through and treat it as a single value.
  }
  return [value];
}

export function parseBulkEmailForm(req: Request, _res: Response, next: NextFunction): void {
  // Only for multipart. A plain JSON request already has the right types, and
  // re-parsing it would turn a real array into an array of characters.
  if (!req.is("multipart/form-data")) {
    next();
    return;
  }
  const body = req.body as Record<string, unknown>;
  body["companyIds"] = toArray(body["companyIds"]);
  body["extraEmails"] = toArray(body["extraEmails"]);
  next();
}
