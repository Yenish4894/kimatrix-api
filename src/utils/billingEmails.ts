/**
 * Pure helpers behind the transactional company emails (QR code, receipts, failed
 * renewals, refunds). Kept free of I/O so the idempotency keys and the money shown to a
 * customer can be tested without Redis or a database.
 */

/** Strips anything that could collide with BullMQ's key separators (it rejects most colons). */
function segment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Deterministic BullMQ job ids, one per (subject, email type).
 *
 * `queue.add` with an id that already exists is a no-op, so a retried capture or a
 * replayed webhook that reaches the enqueue a second time cannot send a second email.
 * That is the belt; the braces are upstream: callers enqueue only when their own
 * transaction actually made the change (first capture, first credit, first reversal).
 */
export const emailJobIds = {
  qrCode: (companyId: string): string => `qr-email-${segment(companyId)}`,
  receipt: (paymentId: string): string => `receipt-${segment(paymentId)}`,
  /**
   * One per subscription per billing period: PAYMENT.SALE.DENIED and
   * BILLING.SUBSCRIPTION.PAYMENT.FAILED usually both fire for the same failure, and
   * PayPal retries a failed cycle several times. Keyed on the access end date the email
   * quotes, the customer hears about each failing period once.
   */
  renewalFailed: (subscriptionId: string, accessUntil: Date | null): string =>
    `payfail-${segment(subscriptionId)}-${accessUntil ? accessUntil.getTime() : "none"}`,
  /** A full reversal happens once per payment; each partial refund has its own PayPal id. */
  refund: (paymentId: string, extent: "full" | "partial", reversalId: string | null): string =>
    extent === "full"
      ? `refund-${segment(paymentId)}-full`
      : `refund-${segment(paymentId)}-${segment(reversalId ?? "partial")}`,
};

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * The amount a refund email should quote.
 *
 * A full reversal quotes the whole payment: the final REFUNDED event of a series of
 * partials carries only its own slice, yet the customer has now been paid back in full.
 * A partial quotes that refund's own amount, or null when PayPal did not send a usable
 * one (the template then says "a partial refund" without a figure rather than guessing).
 */
export function refundDisplayAmount(
  extent: "full" | "partial",
  resource: Record<string, unknown>,
  payment: { amount: string; currency: string },
): { amount: string | null; currency: string } {
  if (extent === "full") return { amount: payment.amount, currency: payment.currency };
  const amount = obj(resource["amount"]);
  const value = typeof amount?.["value"] === "string" ? amount["value"].trim() : null;
  const code = amount?.["currency_code"];
  return {
    amount: value && MONEY.test(value) ? value : null,
    currency: typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : payment.currency,
  };
}
