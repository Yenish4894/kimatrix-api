import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import { parseBulkEmailForm } from "@/middleware/parseBulkEmailForm";

const run = (body: Record<string, unknown>, contentType = "multipart/form-data") => {
  const req = {
    body,
    is: (type: string) =>
      contentType.includes("multipart") && type.includes("multipart") ? type : false,
  } as unknown as Request;
  let calledNext = false;
  parseBulkEmailForm(req, {} as Response, () => {
    calledNext = true;
  });
  assert.ok(calledNext, "middleware must always call next()");
  return req.body as Record<string, unknown>;
};

describe("parseBulkEmailForm", () => {
  it("parses a JSON array of ids", () => {
    const out = run({ companyIds: '["a","b","c"]', extraEmails: "[]" });
    assert.deepEqual(out["companyIds"], ["a", "b", "c"]);
    assert.deepEqual(out["extraEmails"], []);
  });

  it("keeps a single id as a one-element array", () => {
    // The failure this prevents: a string reaching the validator, which then reports
    // "select at least one company" to an admin who had one selected.
    assert.deepEqual(run({ companyIds: '["only-one"]' })["companyIds"], ["only-one"]);
  });

  it("handles a repeated form field, which arrives already as an array", () => {
    assert.deepEqual(run({ companyIds: ["x", "y"] })["companyIds"], ["x", "y"]);
  });

  it("treats a bare non-JSON string as one value rather than dropping it", () => {
    assert.deepEqual(run({ extraEmails: "someone@example.com" })["extraEmails"], [
      "someone@example.com",
    ]);
  });

  it("turns a missing or empty field into an empty array", () => {
    assert.deepEqual(run({})["companyIds"], []);
    assert.deepEqual(run({ companyIds: "" })["companyIds"], []);
  });

  it("leaves a JSON request completely alone", () => {
    // Re-parsing a real array would turn ["ab"] into ["a","b"] — the send would go to
    // addresses that do not exist.
    const out = run({ companyIds: ["ab", "cd"] }, "application/json");
    assert.deepEqual(out["companyIds"], ["ab", "cd"]);
  });
});
