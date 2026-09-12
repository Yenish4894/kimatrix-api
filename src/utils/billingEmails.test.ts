import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emailJobIds, refundDisplayAmount } from "@/utils/billingEmails";

const PAYMENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("emailJobIds", () => {
  it("is deterministic, so a replay produces the same id and BullMQ drops it", () => {
    assert.equal(emailJobIds.receipt(PAYMENT_ID), emailJobIds.receipt(PAYMENT_ID));
    assert.equal(emailJobIds.qrCode(PAYMENT_ID), `qr-email-${PAYMENT_ID}`);
    const end = new Date("2026-10-01T00:00:00Z");
    assert.equal(emailJobIds.renewalFailed("sub", end), emailJobIds.renewalFailed("sub", end));
  });

  it("never contains a colon (BullMQ rejects most colon-bearing ids)", () => {
    const ids = [
      emailJobIds.qrCode("a:b:c:d"),
      emailJobIds.receipt("x:y"),
      emailJobIds.renewalFailed("I-ABC:1", null),
      emailJobIds.refund(PAYMENT_ID, "partial", "RF:1:2"),
    ];
    for (const id of ids) assert.ok(!id.includes(":"), id);
  });

  it("keeps payment emails of different types apart", () => {
    const ids = new Set([
      emailJobIds.receipt(PAYMENT_ID),
      emailJobIds.refund(PAYMENT_ID, "full", null),
      emailJobIds.refund(PAYMENT_ID, "partial", "R1"),
    ]);
    assert.equal(ids.size, 3);
  });

  it("gives each partial refund its own id but a full refund only one", () => {
    assert.notEqual(
      emailJobIds.refund(PAYMENT_ID, "partial", "R1"),
      emailJobIds.refund(PAYMENT_ID, "partial", "R2"),
    );
    assert.equal(
      emailJobIds.refund(PAYMENT_ID, "full", "R1"),
      emailJobIds.refund(PAYMENT_ID, "full", "R2"),
    );
  });

  it("sends one failed-renewal email per billing period, not per retry", () => {
    const a = new Date("2026-10-01T00:00:00Z");
    const b = new Date("2026-10-31T00:00:00Z");
    assert.notEqual(emailJobIds.renewalFailed("S", a), emailJobIds.renewalFailed("S", b));
  });
});

describe("refundDisplayAmount", () => {
  const payment = { amount: "30.00", currency: "USD" };

  it("quotes the whole payment for a full refund, not the last slice", () => {
    const resource = { amount: { value: "10.00", currency_code: "USD" } };
    assert.deepEqual(refundDisplayAmount("full", resource, payment), {
      amount: "30.00",
      currency: "USD",
    });
  });

  it("quotes the refund's own amount for a partial", () => {
    const resource = { amount: { value: "12.50", currency_code: "USD" } };
    assert.deepEqual(refundDisplayAmount("partial", resource, payment), {
      amount: "12.50",
      currency: "USD",
    });
  });

  it("returns no figure rather than a guess when PayPal sent none", () => {
    assert.deepEqual(refundDisplayAmount("partial", {}, payment), {
      amount: null,
      currency: "USD",
    });
    const junk = { amount: { value: "<b>1</b>", currency_code: "us dollars" } };
    assert.deepEqual(refundDisplayAmount("partial", junk, payment), {
      amount: null,
      currency: "USD",
    });
  });
});
