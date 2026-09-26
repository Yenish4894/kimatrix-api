import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  billingStartTime,
  classifyReversal,
  isPaypalCertUrl,
  reversalRefs,
  toCents,
  withoutPayerDetails,
} from "@/utils/paypalBilling";

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
    assert.deepEqual(refs, { orderId: null, captureId: "CAP123", saleId: null });
  });

  it("uses resource.id and the related order id for reversals", () => {
    const refs = reversalRefs("PAYMENT.CAPTURE.REVERSED", {
      id: "CAP9",
      supplementary_data: { related_ids: { order_id: "ORDER9" } },
    });
    assert.deepEqual(refs, { orderId: "ORDER9", captureId: "CAP9", saleId: null });
  });
});

// Shapes taken from a real sandbox PAYMENT.SALE.REFUNDED: amount.total/currency strings,
// the refunded sale as `sale_id`, and no billing_agreement_id.
describe("sale (renewal) reversals", () => {
  const refund = { id: "REF1", sale_id: "SALE1", amount: { total: "29.99", currency: "USD" } };

  it("finds the renewal by its sale id", () => {
    assert.deepEqual(reversalRefs("PAYMENT.SALE.REFUNDED", refund), {
      orderId: null,
      captureId: null,
      saleId: "SALE1",
    });
  });

  it("falls back to the resource id when there is no sale_id", () => {
    assert.equal(reversalRefs("PAYMENT.SALE.REVERSED", { id: "SALE2" }).saleId, "SALE2");
  });

  it("a refund of the whole sale is full, less is partial", () => {
    assert.equal(classifyReversal("PAYMENT.SALE.REFUNDED", refund, "29.99"), "full");
    const part = { ...refund, amount: { total: "10.00", currency: "USD" } };
    assert.equal(classifyReversal("PAYMENT.SALE.REFUNDED", part, "29.99"), "partial");
  });

  it("an unreadable refund amount is partial, never full", () => {
    assert.equal(classifyReversal("PAYMENT.SALE.REFUNDED", { sale_id: "S" }, "29.99"), "partial");
  });

  it("a chargeback is full", () => {
    assert.equal(classifyReversal("PAYMENT.SALE.REVERSED", {}, "29.99"), "full");
  });
});

describe("withoutPayerDetails", () => {
  it("drops the buyer's details and keeps ids, amounts and statuses", () => {
    const event = {
      id: "WH-1",
      event_type: "CHECKOUT.ORDER.COMPLETED",
      resource: {
        id: "ORDER1",
        status: "COMPLETED",
        payer: { email_address: "buyer@example.com", name: { given_name: "B" } },
        subscriber: { email_address: "buyer@example.com" },
        payment_source: { paypal: { email_address: "buyer@example.com" } },
        purchase_units: [{ amount: { value: "29.99" }, shipping: { name: { full_name: "B" } } }],
        disputed_transactions: [{ seller_transaction_id: "CAP1", buyer: { name: "B" } }],
      },
    };
    const out = withoutPayerDetails(event);
    assert.doesNotMatch(JSON.stringify(out), /buyer@example\.com|given_name|full_name|"buyer"/);
    assert.equal(out.id, "WH-1");
    assert.equal(out.resource.id, "ORDER1");
    assert.equal(out.resource.status, "COMPLETED");
    assert.deepEqual(out.resource.purchase_units, [{ amount: { value: "29.99" } }]);
    assert.deepEqual(out.resource.disputed_transactions, [{ seller_transaction_id: "CAP1" }]);
    // The original is not mutated: the handler still reads it after storing.
    assert.ok(event.resource.payer);
  });

  it("leaves an event without a resource alone", () => {
    const event: { id: string; resource?: Record<string, unknown> } = { id: "WH-2" };
    assert.equal(withoutPayerDetails(event), event);
  });
});

describe("isPaypalCertUrl", () => {
  it("accepts PayPal's live and sandbox cert hosts", () => {
    assert.equal(isPaypalCertUrl("https://api.paypal.com/v1/notifications/certs/CERT-1"), true);
    assert.equal(isPaypalCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/C"), true);
  });

  it("rejects other hosts, look-alikes, http and junk", () => {
    assert.equal(isPaypalCertUrl("https://evil.com/cert"), false);
    assert.equal(isPaypalCertUrl("https://paypal.com.evil.com/cert"), false);
    assert.equal(isPaypalCertUrl("https://evilpaypal.com/cert"), false);
    assert.equal(isPaypalCertUrl("http://api.paypal.com/cert"), false);
    assert.equal(isPaypalCertUrl("not a url"), false);
  });
});
