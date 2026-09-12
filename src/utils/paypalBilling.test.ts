import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billingStartTime, classifyReversal, reversalRefs, toCents } from "@/utils/paypalBilling";

describe("billingStartTime", () => {
  const now = new Date("2026-09-13T12:00:00Z");

  it("bills 24 hours before the current access end", () => {
    const end = new Date("2026-09-30T12:00:00Z");
    assert.deepEqual(billingStartTime(end, now), new Date("2026-09-29T12:00:00Z"));
  });

  it("never schedules in the past when access ends within a day", () => {
    const end = new Date("2026-09-14T06:00:00Z");
    assert.deepEqual(billingStartTime(end, now), new Date("2026-09-13T12:01:00Z"));
  });

  it("starts now (plus cushion) with no access or lapsed access", () => {
    assert.deepEqual(billingStartTime(null, now), new Date("2026-09-13T12:01:00Z"));
    assert.deepEqual(
      billingStartTime(new Date("2026-09-01T00:00:00Z"), now),
      new Date("2026-09-13T12:01:00Z"),
    );
  });
});

describe("toCents", () => {
  it("parses money strings without float drift", () => {
    assert.equal(toCents("29.99"), 2999);
    assert.equal(toCents("30"), 3000);
    assert.equal(toCents("0.5"), 50);
    assert.equal(toCents(12.3), 1230);
  });

  it("rejects anything that is not plain money", () => {
    assert.equal(toCents("abc"), null);
    assert.equal(toCents("-1.00"), null);
    assert.equal(toCents(undefined), null);
  });
});

describe("classifyReversal", () => {
  it("treats reversals and denials as full", () => {
    assert.equal(classifyReversal("PAYMENT.CAPTURE.REVERSED", {}, "29.99"), "full");
    assert.equal(classifyReversal("PAYMENT.CAPTURE.DENIED", {}, "29.99"), "full");
  });

  it("uses the cumulative refunded total when present", () => {
    const partial = {
      amount: { value: "10.00" },
      seller_payable_breakdown: { total_refunded_amount: { value: "10.00" } },
    };
    assert.equal(classifyReversal("PAYMENT.CAPTURE.REFUNDED", partial, "29.99"), "partial");

    // A second partial refund that brings the total to the full amount.
    const completing = {
      amount: { value: "19.99" },
      seller_payable_breakdown: { total_refunded_amount: { value: "29.99" } },
    };
    assert.equal(classifyReversal("PAYMENT.CAPTURE.REFUNDED", completing, "29.99"), "full");
  });

  it("falls back to the refund's own amount", () => {
    assert.equal(
      classifyReversal("PAYMENT.CAPTURE.REFUNDED", { amount: { value: "29.99" } }, "29.99"),
      "full",
    );
  });

  it("is conservative when amounts are missing or unparseable", () => {
    assert.equal(classifyReversal("PAYMENT.CAPTURE.REFUNDED", {}, "29.99"), "partial");
    assert.equal(
      classifyReversal("PAYMENT.CAPTURE.REFUNDED", { amount: { value: "x" } }, "29.99"),
      "partial",
    );
  });
});

describe("reversalRefs", () => {
  it("takes the capture id from the refund's up link", () => {
    const refs = reversalRefs("PAYMENT.CAPTURE.REFUNDED", {
      id: "REFUND1",
      links: [
        { rel: "self", href: "https://api.paypal.com/v2/payments/refunds/REFUND1" },
        { rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP123" },
      ],
    });
    assert.deepEqual(refs, { orderId: null, captureId: "CAP123" });
  });

  it("uses resource.id and the related order id for reversals", () => {
    const refs = reversalRefs("PAYMENT.CAPTURE.REVERSED", {
      id: "CAP9",
      supplementary_data: { related_ids: { order_id: "ORDER9" } },
    });
    assert.deepEqual(refs, { orderId: "ORDER9", captureId: "CAP9" });
  });
});
