/**
 * What to do with a payment stuck in `capturing`, decided from PayPal's view of the
 * order. Pure, so every branch is testable without PayPal or a database.
 *
 * A payment reaches `capturing` when the buyer came back from PayPal and we claimed the
 * row, then lost the capture call (timeout, crash, deploy). The money may or may not
 * have moved. The webhook usually settles it, but a webhook can be lost too, and until
 * now nothing else ever looked: the customer paid and never got access, or the row sat
 * there forever.
 */

/** Old enough that the synchronous capture and its webhook have both had their chance. */
export const RECONCILE_AFTER_MINUTES = 15;

/** Rows per run. Each costs one PayPal call of up to 15s. */
export const RECONCILE_BATCH_SIZE = 10;

export interface PaypalOrderView {
  status?: string;
  purchase_units?: {
    payments?: { captures?: { id?: string; status?: string }[] };
  }[];
}

export type StuckCaptureDecision =
  | { action: "complete" }
  | { action: "fail"; reason: string }
  | { action: "wait"; reason: string };

/**
 * @param order PayPal's order, or null when PayPal answers 404 (it has no such order).
 */
export function decideStuckCapture(order: PaypalOrderView | null): StuckCaptureDecision {
  if (!order) return { action: "fail", reason: "order_unknown_to_paypal" };

  const captureStatus = order.purchase_units?.[0]?.payments?.captures?.[0]?.status;
  switch (captureStatus) {
    case "COMPLETED":
      // PayPal took the money. Grant what was paid for.
      return { action: "complete" };
    case "PENDING":
      // Money is on its way (eCheck, review). PayPal sends PAYMENT.CAPTURE.COMPLETED
      // when it clears; granting now would give access for money that may never land.
      return { action: "wait", reason: "capture_pending_at_paypal" };
    case "DECLINED":
    case "FAILED":
      return { action: "fail", reason: "capture_declined" };
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      // Captured and already given back before we ever recorded it. Nothing to grant.
      return { action: "fail", reason: "capture_refunded_before_reconcile" };
    case undefined:
      break;
    default:
      return { action: "wait", reason: `capture_status_${captureStatus}` };
  }

  switch (order.status) {
    // Approved but never captured: our capture call never reached PayPal. The buyer was
    // shown an error and was NOT charged, so this is closed rather than captured behind
    // their back hours later — taking money silently is worse than asking them to pay
    // again.
    case "APPROVED":
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      return { action: "fail", reason: "capture_never_completed" };
    case "VOIDED":
      return { action: "fail", reason: "order_voided" };
    default:
      // COMPLETED with no capture listed, or a status PayPal adds later: leave it for a
      // human (it is logged every run) rather than guess in either direction.
      return { action: "wait", reason: `order_status_${order.status ?? "missing"}` };
  }
}
