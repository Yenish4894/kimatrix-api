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
  | "PAYMENT.CAPTURE.DENIED";

export const REVERSAL_EVENT_TYPES: readonly ReversalEventType[] = [
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.CAPTURE.DENIED",
];

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
 * The identifiers a reversal event carries for the capture it reverses.
 *
 * REVERSED and DENIED deliver the capture itself, so `resource.id` is the capture id.
 * REFUNDED delivers the refund, whose own id is useless to us; the capture is its
 * `rel: "up"` link. Either may carry `supplementary_data.related_ids.order_id`, which is
 * the cheapest match and is preferred when present.
 */
export function reversalRefs(
  eventType: ReversalEventType,
  resource: Json,
): { orderId: string | null; captureId: string | null } {
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
  return { orderId, captureId };
}

/**
 * Whether a reversal takes back the whole payment.
 *
 * REVERSED (chargeback) and DENIED always remove the full amount. A refund is full only
 * when PayPal's cumulative `total_refunded_amount` (falling back to this refund's own
 * amount) reaches what we recorded. Anything we cannot parse is treated as PARTIAL:
 * wrongly revoking a paying customer's access is worse than leaving it for a human.
 */
export function classifyReversal(
  eventType: ReversalEventType,
  resource: Json,
  paymentAmount: string | number,
): "full" | "partial" {
  if (eventType !== "PAYMENT.CAPTURE.REFUNDED") return "full";

  const paid = toCents(paymentAmount);
  const breakdown = obj(resource["seller_payable_breakdown"]);
  const total = toCents(obj(breakdown?.["total_refunded_amount"])?.["value"]);
  const single = toCents(obj(resource["amount"])?.["value"]);
  const refunded = total ?? single;

  if (paid == null || refunded == null || paid <= 0) return "partial";
  return refunded >= paid ? "full" : "partial";
}
