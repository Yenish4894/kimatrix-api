import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderQrCodeEmail } from "@/templates/qrCode.template";
import { renderPaymentReceiptEmail } from "@/templates/paymentReceipt.template";
import { renderPaymentFailedEmail } from "@/templates/paymentFailed.template";
import {
  renderRefundProcessedEmail,
  type RefundAccessChange,
} from "@/templates/refundProcessed.template";

const BILLING = "https://kimates.com/company/billing";
const HOSTILE = `Tom & Jerry's <script>alert(1)</script> "Fuel"`;
const NOW = new Date("2026-09-13T12:00:00Z");

const receipt = (over: Partial<Parameters<typeof renderPaymentReceiptEmail>[0]> = {}) =>
  renderPaymentReceiptEmail({
    companyName: "Station Total Durban",
    invoiceNumber: "INV-20260913-3FA85F64",
    kind: "order",
    description: "30-day plan",
    amount: "29.00",
    currency: "USD",
    periodStart: new Date("2026-09-13T00:00:00Z"),
    periodEnd: new Date("2026-10-13T00:00:00Z"),
    paidAt: NOW,
    billingUrl: BILLING,
    ...over,
  });

const refund = (access: RefundAccessChange, extent: "full" | "partial" = "full") =>
  renderRefundProcessedEmail({
    companyName: "Station Total Durban",
    extent,
    amount: "29.00",
    currency: "USD",
    description: "30-day plan",
    invoiceNumber: "INV-20260913-3FA85F64",
    access,
    billingUrl: BILLING,
    now: NOW,
  });

describe("QR code email", () => {
  it("has the agreed subject, the company, the link and the print instruction", () => {
    const { subject, text } = renderQrCodeEmail({
      companyName: "Shop One",
      qrUrl: "https://kimates.com/qr/tok",
    });
    assert.equal(subject, "Your KIMates QR code");
    assert.ok(text.includes("Shop One"));
    assert.ok(text.includes("https://kimates.com/qr/tok"));
    assert.match(text, /print/i);
    assert.match(text, /attached/i);
  });
});

describe("payment receipt email", () => {
  it("uses the agreed subject and states amount, purpose, period and invoice", () => {
    const { subject, text } = receipt();
    assert.equal(subject, "Payment received — KIMates");
    assert.ok(text.includes("USD 29.00"));
    assert.ok(text.includes("30-day plan"));
    assert.ok(text.includes("13 September 2026"));
    assert.ok(text.includes("13 October 2026"));
    assert.ok(text.includes("INV-20260913-3FA85F64"));
    assert.ok(text.includes(BILLING));
  });

  it("names a renewal as a renewal and a spin add-on as spins", () => {
    assert.match(receipt({ kind: "subscription_cycle" }).text, /automatic plan renewal/);
    const spins = receipt({ kind: "spin_addon", description: "5 lucky draw spins" }).text;
    assert.match(spins, /lucky draw/);
    assert.match(spins, /Draw period/);
    assert.doesNotMatch(spins, /plan now runs/);
  });

  it("omits the period row when there is none", () => {
    assert.doesNotMatch(receipt({ periodStart: null, periodEnd: null }).text, /Period:/);
  });
});

describe("payment failed email", () => {
  it("says PayPal will retry, access continues to the end date, and links billing", () => {
    const { subject, text } = renderPaymentFailedEmail({
      companyName: "Shop One",
      accessUntil: new Date("2026-09-20T00:00:00Z"),
      billingUrl: BILLING,
      now: NOW,
    });
    assert.match(subject, /didn't go through/);
    assert.match(text, /retry/i);
    assert.ok(text.includes("20 September 2026"));
    assert.ok(text.includes(BILLING));
  });

  it("never quotes an end date that has already passed", () => {
    const { text } = renderPaymentFailedEmail({
      companyName: "Shop One",
      accessUntil: new Date("2026-09-01T00:00:00Z"),
      billingUrl: BILLING,
      now: NOW,
    });
    assert.ok(!text.includes("1 September 2026"));
    assert.match(text, /end of your current paid period/);
  });
});

describe("refund processed email", () => {
  it("gives the new access end date for a refunded plan", () => {
    const { subject, text } = refund({
      type: "access_reduced",
      newEndsAt: "2026-09-30T00:00:00.000Z",
      spinsRemoved: false,
    });
    assert.equal(subject, "Refund processed — KIMates");
    assert.ok(text.includes("USD 29.00"));
    assert.ok(text.includes("30 September 2026"));
  });

  it("says access has ended when the refund leaves no paid time", () => {
    const { text } = refund({
      type: "access_reduced",
      newEndsAt: "2026-09-01T00:00:00.000Z",
      spinsRemoved: true,
    });
    assert.match(text, /paid access ended on 1 September 2026/);
    assert.match(text, /spins bought with it have been removed/);
  });

  it("says the spins were removed for a refunded add-on", () => {
    assert.match(refund({ type: "spins_removed" }).text, /spins from this purchase were removed/);
  });

  it("says nothing changed for a partial refund", () => {
    const { subject, text } = refund({ type: "none" }, "partial");
    assert.equal(subject, "Partial refund processed — KIMates");
    assert.match(text, /No change to your access/);
  });

  it("does not invent a figure when the amount is unknown", () => {
    const { text } = renderRefundProcessedEmail({
      companyName: "Shop One",
      extent: "partial",
      amount: null,
      currency: "USD",
      description: "30-day plan",
      invoiceNumber: null,
      access: { type: "none" },
      billingUrl: BILLING,
    });
    assert.match(text, /A partial refund has been issued/);
    assert.doesNotMatch(text, /USD/);
  });
});

describe("every billing email escapes company-supplied text", () => {
  const all = [
    renderQrCodeEmail({ companyName: HOSTILE, qrUrl: "https://kimates.com/qr/t" }),
    receipt({ companyName: HOSTILE, description: HOSTILE }),
    renderPaymentFailedEmail({ companyName: HOSTILE, accessUntil: null, billingUrl: BILLING }),
    renderRefundProcessedEmail({
      companyName: HOSTILE,
      extent: "full",
      amount: "1.00",
      currency: "USD",
      description: HOSTILE,
      invoiceNumber: null,
      access: { type: "spins_removed" },
      billingUrl: BILLING,
    }),
  ];
  for (const [i, { html, text }] of all.entries()) {
    it(`email #${i + 1}`, () => {
      assert.ok(!html.includes("<script>"), "raw <script> in html");
      assert.ok(html.includes("Tom &amp; Jerry&#39;s &lt;script&gt;"));
      // The plain-text part is not HTML and must keep the name readable.
      assert.ok(text.includes(HOSTILE));
    });
  }
});
