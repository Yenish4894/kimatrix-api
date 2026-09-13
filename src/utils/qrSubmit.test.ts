import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  INVOICE_ALREADY_SUBMITTED,
  qrSubmitConflict,
  submissionLockKeys,
  uniqueViolationConstraint,
} from "@/utils/qrSubmit";

describe("QR submission conflicts", () => {
  it("turns a duplicate invoice into the specific 409, not the generic one", () => {
    const err = qrSubmitConflict({ code: "23505", constraint: "uq_purchases_company_invoice" });
    assert.equal(err?.statusCode, 409);
    assert.equal(err?.message, INVOICE_ALREADY_SUBMITTED);
  });

  it("reads the constraint through TypeORM's driverError wrapper as well", () => {
    const wrapped = { driverError: { code: "23505", constraint: "uq_customers_shop_mobile" } };
    assert.equal(uniqueViolationConstraint(wrapped), "uq_customers_shop_mobile");
    assert.equal(qrSubmitConflict(wrapped)?.statusCode, 429);
  });

  it("leaves every other error alone", () => {
    assert.equal(qrSubmitConflict(new Error("boom")), null);
    assert.equal(qrSubmitConflict({ code: "23505", constraint: "uq_something_else" }), null);
    assert.equal(qrSubmitConflict({ code: "40001" }), null);
    assert.equal(qrSubmitConflict(null), null);
  });

  it("locks mobile before invoice, in separate namespaces per company", () => {
    const keys = submissionLockKeys("co-1", "+27820000000", "INV-9");
    assert.deepEqual(keys, [
      ["qr-mobile:co-1", "+27820000000"],
      ["qr-invoice:co-1", "INV-9"],
    ]);
  });
});

describe("QR submission ordering (source pins)", () => {
  const read = (...p: string[]) => readFileSync(path.join(process.cwd(), "src", ...p), "utf8");

  it("takes the submission locks before the cooldown and invoice checks", () => {
    const src = read("services", "QrService.ts");
    const lock = src.indexOf("await this.lockSubmission(");
    const cooldown = src.indexOf("await this.assertResubmitCooldown(");
    const invoice = src.indexOf("findByCompanyAndInvoice(");
    assert.ok(lock >= 0, "lockSubmission is not called");
    assert.ok(
      lock < cooldown && lock < invoice,
      "locks must be taken before the checks they guard",
    );
  });

  it("runs the QR rate limiters before the validators", () => {
    const src = read("routes", "qr.route.ts");
    const submit = src.slice(src.indexOf('"/:qrToken/submit"'));
    const lastLimiter = submit.indexOf("qrSubmitPerDevicePerDayLimiter");
    const firstValidator = submit.indexOf("validateRequest(");
    assert.ok(submit.indexOf("qrSubmitPerMinuteLimiter") < firstValidator);
    assert.ok(submit.indexOf("qrSubmitPerDayLimiter") < firstValidator);
    assert.ok(lastLimiter >= 0 && lastLimiter < firstValidator);
  });
});
