import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BULK_EMAIL_MAX_RECIPIENTS, sendBulkEmailSchema } from "@/validation/schemas/admin.schema";
import { AUDIT_ACTIONS } from "@/entities/AdminAuditLog";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

describe("bulk email recipient cap (SEC-7)", () => {
  const base = { subject: "Hello", body: "News", extraEmails: [] };

  it("accepts a company list at the cap", () => {
    const companyIds = Array.from({ length: BULK_EMAIL_MAX_RECIPIENTS }, (_, i) => uuid(i));
    assert.equal(sendBulkEmailSchema.validate({ ...base, companyIds }).error, undefined);
  });

  it("rejects a company list over the cap with a readable message", () => {
    const companyIds = Array.from({ length: BULK_EMAIL_MAX_RECIPIENTS + 1 }, (_, i) => uuid(i));
    const { error } = sendBulkEmailSchema.validate({ ...base, companyIds });
    assert.match(error?.message ?? "", new RegExp(`up to ${BULK_EMAIL_MAX_RECIPIENTS} companies`));
  });
});

describe("audit actions (OBS-4)", () => {
  it("include extend-trial and release-trial-identity, so the audit-log filter accepts them", () => {
    assert.ok(AUDIT_ACTIONS.includes("company.trial_extend"));
    assert.ok(AUDIT_ACTIONS.includes("trial_identity.release"));
  });
});
