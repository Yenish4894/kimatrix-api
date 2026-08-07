import { AppDataSource } from "data-source";
import { SubscriptionService } from "@/services/SubscriptionService";
import { PaypalService } from "@/services/PaypalService";
import { returningRows } from "@/utils/db";
import { logger } from "@/utils/logger";

interface WebhookEvent {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource?: Record<string, unknown>;
}

/**
 * Handles every PayPal webhook, for both the Orders era and the Subscriptions era.
 *
 * Three rules the previous implementation broke, all of which cost money when broken:
 *
 * 1. **Idempotency is enforced by the database, not by a lookup.** The event row is
 *    inserted first with `ON CONFLICT DO NOTHING RETURNING id`; no row back means this
 *    event has already been handled. Reading a table and then deciding is a race, and
 *    PayPal retries aggressively enough to lose it.
 *
 * 2. **Ordering is never assumed.** PayPal does not guarantee it, so an event whose
 *    `create_time` predates what we last applied is discarded — otherwise a delayed
 *    ACTIVATED resurrects a subscription the customer already cancelled.
 *
 * 3. **A failure must throw**, so the controller can answer non-2xx and PayPal retries.
 *    Swallowing an error and returning 200 tells PayPal the event was handled and it is
 *    never sent again — which is how a payment silently goes uncredited.
 */
export class PaypalWebhookService {
  private subscriptionService = new SubscriptionService();
  private paypalService = new PaypalService();

  /**
   * @returns false when the event was a duplicate or is of no interest to us.
   */
  async handle(event: WebhookEvent): Promise<boolean> {
    const eventId = event.id;
    const eventType = event.event_type ?? "";
    if (!eventId) {
      logger.warn({ eventType }, "Webhook without an event id — ignoring");
      return false;
    }

    const resource = event.resource ?? {};
    const resourceId = typeof resource["id"] === "string" ? resource["id"] : null;
    const createTime = event.create_time ? new Date(event.create_time) : null;

    // Insert-first. This is the idempotency guarantee.
    const claimed = returningRows<{ id: string }>(
      await AppDataSource.query(
        `INSERT INTO "paypal_webhook_events"
           ("event_id", "event_type", "resource_id", "create_time", "payload")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("event_id") DO NOTHING
         RETURNING "id"`,
        [eventId, eventType, resourceId, createTime, JSON.stringify(event)],
      ),
    );
    if (claimed.length === 0) {
      logger.info({ eventId, eventType }, "Duplicate webhook — already processed");
      return false;
    }

    try {
      await this.dispatch(eventType, resource, createTime);
    } catch (err) {
      // Release the claim before rethrowing.
      //
      // The row was inserted BEFORE dispatch, which is what makes idempotency
      // race-proof — but it also means a transient failure here would make PayPal's
      // retry look like a duplicate and get skipped, losing the event permanently.
      // The controller answers 5xx on this throw so PayPal does retry; deleting the
      // row is what lets that retry actually do something.
      await AppDataSource.query(`DELETE FROM "paypal_webhook_events" WHERE "event_id" = $1`, [
        eventId,
      ]).catch((cleanupErr: unknown) => {
        logger.error(
          { err: cleanupErr, eventId },
          "Failed to release a webhook claim — PayPal's retry will be treated as a duplicate",
        );
      });
      throw err;
    }

    await AppDataSource.query(
      `UPDATE "paypal_webhook_events" SET "processed_at" = now() WHERE "event_id" = $1`,
      [eventId],
    );
    return true;
  }

  private async dispatch(
    eventType: string,
    resource: Record<string, unknown>,
    createTime: Date | null,
  ): Promise<void> {
    switch (eventType) {
      // ── Subscription lifecycle ────────────────────────────────────────────
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.UPDATED":
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.RE-ACTIVATED": {
        const id = resource["id"];
        if (typeof id !== "string") return;
        // Read the state back from PayPal rather than trusting the webhook body: the
        // body is a snapshot from when the event was queued and may already be stale
        // by the time a retry delivers it.
        const remote = await this.paypalService.getSubscription(id);
        if (!remote) return; // Unknown to PayPal — retrying will never help.
        await this.subscriptionService.applyRemoteState(id, remote, createTime ?? undefined);
        return;
      }

      // ── Money actually moving ─────────────────────────────────────────────
      case "PAYMENT.SALE.COMPLETED": {
        const saleId = resource["id"];
        const billingAgreementId = resource["billing_agreement_id"];
        const amount = resource["amount"] as { total?: string; currency?: string } | undefined;
        if (typeof saleId !== "string" || typeof billingAgreementId !== "string") {
          // A sale with no billing agreement is an Orders-era capture, handled by the
          // synchronous capture path and its own webhook branch.
          return;
        }
        await this.subscriptionService.creditCycle({
          paypalSubscriptionId: billingAgreementId,
          saleId,
          amount: amount?.total ?? "0.00",
          currency: amount?.currency ?? "USD",
        });
        return;
      }

      case "PAYMENT.SALE.DENIED":
      case "PAYMENT.SALE.REFUNDED":
      case "PAYMENT.SALE.REVERSED": {
        const billingAgreementId = resource["billing_agreement_id"];
        if (typeof billingAgreementId !== "string") return;
        // Deliberately does NOT revoke access. PayPal retries a failed payment inside a
        // period the customer has already paid for, so cutting them off here would be
        // wrong; the state is reflected as `past_due` and the natural expiry handles
        // the rest if it is never paid.
        const remote = await this.paypalService.getSubscription(billingAgreementId);
        if (!remote) return;
        await this.subscriptionService.applyRemoteState(
          billingAgreementId,
          remote,
          createTime ?? undefined,
        );
        return;
      }

      default:
        logger.info({ eventType }, "Webhook type not handled");
    }
  }
}
