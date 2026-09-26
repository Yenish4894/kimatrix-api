/**
 * Pure helpers for PayPal billing decisions, kept free of I/O so they can be tested
 * without a database or PayPal.
 */

/** How far ahead of the current access end a recurring charge is scheduled. */
export const RENEWAL_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * PayPal rejects a start time in the past, and "now" here is always a few seconds stale
 * by the time the request lands, so the floor carries a small cushion.
 */
export const START_TIME_CUSHION_MS = 60_000;

/**
 * When PayPal should take the first recurring payment.
 *
 * Billing exactly at the access end means access lapses in the gap between expiry and
 * PAYMENT.SALE.COMPLETED arriving, and the paywall hits a paying customer every cycle.
 * Charging a day early closes that gap without costing the customer anything, because
 * the credit stacks onto the existing expiry (GREATEST(...) + interval) rather than
 * starting from the charge time.
 */
export function billingStartTime(accessEndsAt: Date | null, now: Date): Date {
  const earliest = new Date(now.getTime() + START_TIME_CUSHION_MS);
  if (!accessEndsAt) return earliest;
  const early = new Date(accessEndsAt.getTime() - RENEWAL_LEAD_MS);
  return early > earliest ? early : earliest;
}

export type ReversalEventType =
  | "PAYMENT.CAPTURE.REFUNDED"
  | "PAYMENT.CAPTURE.REVERSED"
  | "PAYMENT.CAPTURE.DENIED"
  // Subscription renewals are v1 "sales", not v2 captures.
  | "PAYMENT.SALE.REFUNDED"
  | "PAYMENT.SALE.REVERSED";

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** "12.34" → 1234. Null when it is not a plain decimal money string. */
export function toCents(value: unknown): number | null {
  const text = typeof value === "number" ? value.toFixed(2) : value;
  if (typeof text !== "string" || !/^\d+(\.\d{1,2})?$/.test(text.trim())) return null;
  const [whole, frac = ""] = text.trim().split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/**
 * Whether a recurring sale paid exactly the plan's price, in the plan's currency.
 *
 * PayPal's sale amount is the only evidence of what was actually charged. A cycle that
 * paid something else — a plan edited at PayPal, a currency slip, a partial capture —
 * used to be credited a full period regardless. Compared in cents so "10" and "10.00"
 * agree; anything unparseable counts as a mismatch.
 */
export function saleMatchesPlan(
  sale: { amount: unknown; currency: unknown },
  plan: { price: unknown; currency: unknown },
): boolean {
  const paid = toCents(sale.amount);
  const price = toCents(plan.price);
  if (paid == null || price == null || paid !== price) return false;
  return (
    typeof sale.currency === "string" &&
    typeof plan.currency === "string" &&
    sale.currency.trim().toUpperCase() === plan.currency.trim().toUpperCase()
  );
}

/**
 * Whether the caller may confirm this subscription.
 *
 * Our own row is the authority: it is written with the company id before the buyer is
 * sent to PayPal, so it exists for every legitimate confirm. PayPal's `custom_id` is
 * checked as well when it is present, but it can be missing, and ownership used to be
 * skipped entirely whenever it was.
 */
export function subscriptionBelongsTo(
  localCompanyId: string | null | undefined,
  remoteCustomId: string | null | undefined,
  companyId: string,
): boolean {
  if (!localCompanyId || localCompanyId !== companyId) return false;
  return !remoteCustomId || remoteCustomId === companyId;
}

/**
 * The identifiers a reversal event carries for the capture it reverses.
 *
 * REVERSED and DENIED deliver the capture itself, so `resource.id` is the capture id.
 * REFUNDED delivers the refund, whose own id is useless to us; the capture is its
 * `rel: "up"` link. Either may carry `supplementary_data.related_ids.order_id`, which is
 * the cheapest match and is preferred when present.
 *
 * A sale refund/reversal (a subscription renewal) carries the sale it reverses as
 * `sale_id` — the same id stored from PAYMENT.SALE.COMPLETED. It carries no
 * `billing_agreement_id`, which is why these events used to be dropped.
 */
export function reversalRefs(
  eventType: ReversalEventType,
  resource: Json,
): { orderId: string | null; captureId: string | null; saleId: string | null } {
  if (eventType === "PAYMENT.SALE.REFUNDED" || eventType === "PAYMENT.SALE.REVERSED") {
    const sale = resource["sale_id"] ?? resource["id"];
    return { orderId: null, captureId: null, saleId: typeof sale === "string" ? sale : null };
  }

  const related = obj(obj(resource["supplementary_data"])?.["related_ids"]);
  const orderId = typeof related?.["order_id"] === "string" ? related["order_id"] : null;

  let captureId: string | null = null;
  if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
    const links = Array.isArray(resource["links"]) ? (resource["links"] as unknown[]) : [];
    for (const link of links) {
      const l = obj(link);
      if (l?.["rel"] === "up" && typeof l["href"] === "string") {
        const m = /\/captures\/([^/?#]+)/.exec(l["href"]);
        if (m) captureId = decodeURIComponent(m[1]!);
      }
    }
    if (!captureId && typeof related?.["capture_id"] === "string") {
      captureId = related["capture_id"];
    }
  } else if (typeof resource["id"] === "string") {
    captureId = resource["id"];
  }
  return { orderId, captureId, saleId: null };
}

/** Where a PayPal webhook resource carries the buyer's name, email, address or messages. */
const PAYER_KEYS = ["payer", "subscriber", "payment_source", "shipping", "buyer", "messages"];

/**
 * A copy of a webhook event without the buyer's personal details, for storage in the
 * idempotency ledger. Nothing we reprocess reads them; ids, amounts and statuses stay.
 * Covers the resource and objects one level down (purchase_units[].shipping,
 * disputed_transactions[].buyer).
 */
export function withoutPayerDetails<T extends { resource?: Json }>(event: T): T {
  const resource = obj(event.resource);
  if (!resource) return event;
  const strip = (o: Json): Json =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !PAYER_KEYS.includes(k)));
  const cleaned = Object.fromEntries(
    Object.entries(strip(resource)).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.map((item) => (obj(item) ? strip(item as Json) : item)) : v,
    ]),
  );
  return { ...event, resource: cleaned };
}

/**
 * Whether a reversal takes back the whole payment.
 *
 * REVERSED (chargeback) and DENIED always remove the full amount. A refund is full only
 * when PayPal's cumulative `total_refunded_amount` (falling back to this refund's own
 * amount) reaches what we recorded. A sale refund carries only its own
 * `amount.total`. Anything we cannot parse is treated as PARTIAL: wrongly revoking a
 * paying customer's access is worse than leaving it for a human.
 */
export function classifyReversal(
  eventType: ReversalEventType,
  resource: Json,
  paymentAmount: string | number,
): "full" | "partial" {
  const paid = toCents(paymentAmount);
  if (eventType === "PAYMENT.SALE.REFUNDED") {
    const refunded = toCents(obj(resource["amount"])?.["total"]);
    if (paid == null || refunded == null || paid <= 0) return "partial";
    return refunded >= paid ? "full" : "partial";
  }
  if (eventType !== "PAYMENT.CAPTURE.REFUNDED") return "full";

  const breakdown = obj(resource["seller_payable_breakdown"]);
  const total = toCents(obj(breakdown?.["total_refunded_amount"])?.["value"]);
  const single = toCents(obj(resource["amount"])?.["value"]);
  const refunded = total ?? single;

  if (paid == null || refunded == null || paid <= 0) return "partial";
  return refunded >= paid ? "full" : "partial";
}
