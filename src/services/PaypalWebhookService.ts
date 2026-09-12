import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { SubscriptionService } from "@/services/SubscriptionService";
import { PaypalService } from "@/services/PaypalService";
import { PaymentRepository } from "@/repositories/PaymentRepository";
import { returningRows } from "@/utils/db";
import { logger } from "@/utils/logger";
import { classifyReversal, reversalRefs, type ReversalEventType } from "@/utils/paypalBilling";
import { NotificationService, type RefundNotice } from "@/services/NotificationService";
import { refundDisplayAmount } from "@/utils/billingEmails";
import type { RefundAccessChange } from "@/templates/refundProcessed.template";

/**
 * `admin_audit_log.actor_email` is NOT NULL while `actor_user_id` is nullable, so a
 * system-initiated row carries no user and this marker instead.
 */
const SYSTEM_ACTOR_EMAIL = "system:paypal-webhook";

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
  private paymentRepository = new PaymentRepository();
  private notificationService = new NotificationService();

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

      // A recurring charge failed. PayPal keeps the subscription ACTIVE while it
      // retries, so like PAYMENT.SALE.DENIED this revokes nothing: applyRemoteState marks
      // it past_due, and the owner is told. Previously this fell through to "not handled".
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
        const id = resource["id"];
        if (typeof id !== "string") return;
        const remote = await this.paypalService.getSubscription(id);
        if (!remote) return;
        await this.subscriptionService.applyRemoteState(id, remote, createTime ?? undefined);
        // applyRemoteState has committed. Not awaited; cannot throw.
        void this.notificationService.sendRenewalFailed(id);
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
        // Deliberately does NOT revoke access. Renewals are charged a day before the
        // current access end, so a failed renewal is retried by PayPal while the
        // customer still holds time from the previous, successfully paid cycle; a sale
        // that failed was never credited, so there is nothing to take back. The state
        // is reflected as `past_due` and the natural expiry handles the rest if it is
        // never paid.
        const remote = await this.paypalService.getSubscription(billingAgreementId);
        if (!remote) return;
        await this.subscriptionService.applyRemoteState(
          billingAgreementId,
          remote,
          createTime ?? undefined,
        );
        // A declined renewal. (A refunded/reversed renewal sale sends nothing: this code
        // does not take access back for those, so there is no change to report.)
        if (eventType === "PAYMENT.SALE.DENIED") {
          void this.notificationService.sendRenewalFailed(billingAgreementId);
        }
        return;
      }

      // ── Orders-era money going back ───────────────────────────────────────
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.REVERSED":
      case "PAYMENT.CAPTURE.DENIED":
        await this.handleCaptureReversal(eventType, resource);
        return;

      default:
        logger.info({ eventType }, "Webhook type not handled");
    }
  }

  /**
   * A one-time capture was refunded, charged back or denied after we recorded it.
   *
   * Previously these fell through to "not handled", so a refunded customer kept the
   * access (and the draw spins) they had been paid back for.
   *
   * Idempotent at two levels: the webhook-event claim in `handle` stops the same event
   * twice, and a payment already `refunded` is left alone, so a different event for
   * the same capture (a REVERSED after a REFUNDED, say) cannot subtract access twice.
   *
   * A partial refund is recorded and flagged but takes nothing away. Deciding how many
   * days a partial refund is worth is a judgement call for a human, and wrongly locking
   * out a paying customer is the worse error.
   */
  private async handleCaptureReversal(
    eventType: ReversalEventType,
    resource: Record<string, unknown>,
  ): Promise<void> {
    const refs = reversalRefs(eventType, resource);
    if (!refs.orderId && !refs.captureId) {
      logger.warn(
        { eventType, resourceId: resource["id"] },
        "Reversal without a capture reference",
      );
      return;
    }

    // Decided inside the transaction, sent after it commits (see the end of this method).
    let notice = null as RefundNotice | null;
    await AppDataSource.transaction(async (manager) => {
      const payment = await this.paymentRepository.findForReversalForUpdate(refs, manager);
      if (!payment) {
        // Not thrown: no retry will ever make an unknown capture known, and throwing
        // would have PayPal retry for days. Loud enough for someone to reconcile by hand.
        logger.error({ eventType, ...refs }, "Reversal for a capture we have no payment for");
        return;
      }
      if (payment.status === "refunded") {
        logger.info({ eventType, paymentId: payment.id }, "Payment already reversed — no-op");
        return;
      }

      const extent = classifyReversal(eventType, resource, payment.amount);
      const reversalId = typeof resource["id"] === "string" ? resource["id"] : null;
      const entry = {
        event_type: eventType,
        id: reversalId,
        status: resource["status"] ?? null,
        amount: resource["amount"] ?? null,
        extent,
        received_at: new Date().toISOString(),
      };
      // Appended rather than overwriting `paypal_response`: the capture body is how a
      // later reversal event finds this row by capture id.
      const appendEntrySql = `COALESCE("paypal_response", '{}'::jsonb)
        || jsonb_build_object('reversals',
             COALESCE("paypal_response"->'reversals', '[]'::jsonb) || $2::jsonb)`;

      if (extent === "partial") {
        const seen = Array.isArray(payment.paypal_response?.["reversals"])
          ? (payment.paypal_response["reversals"] as { id?: unknown }[]).some(
              (r) => reversalId != null && r?.id === reversalId,
            )
          : false;
        if (seen) return;
        await manager.query(
          `UPDATE "payments" SET "paypal_response" = ${appendEntrySql} WHERE "id" = $1`,
          [payment.id, JSON.stringify([entry])],
        );
        await this.audit(manager, "payment.partial_refund", payment.id, {
          before: { status: payment.status },
          after: { status: payment.status, refund: entry },
          note: "Partial refund — access left unchanged; review manually",
        });
        logger.warn(
          { paymentId: payment.id, companyId: payment.company_id, refund: entry },
          "Partial PayPal refund — payment flagged, access NOT revoked",
        );
        notice = {
          paymentId: payment.id,
          companyId: payment.company_id,
          extent: "partial",
          reversalId,
          ...refundDisplayAmount("partial", resource, payment),
          access: { type: "none" },
        };
        return;
      }

      // A DENIED capture we never recorded as captured was simply never paid; `failed`
      // describes it better than `refunded`. Everything else is money returned.
      const wasCaptured = payment.status === "captured";
      const newStatus =
        !wasCaptured && eventType === "PAYMENT.CAPTURE.DENIED" ? "failed" : "refunded";
      await manager.query(
        `UPDATE "payments"
            SET "status" = $3, "paypal_response" = ${appendEntrySql}, "updated_at" = now()
          WHERE "id" = $1`,
        [payment.id, JSON.stringify([entry]), newStatus],
      );

      // Take back exactly the window this order added. Only an `order` grants access
      // (a `spin_addon` is withdrawn by the status change alone: spins count only
      // `captured` payments). Subtracting the window's length rather than resetting to
      // its start keeps any time bought after it — later orders or renewals stacked
      // on top by GREATEST(...) + interval.
      let access: { before: Date | null; after: Date | null } | null = null;
      if (
        wasCaptured &&
        payment.kind === "order" &&
        payment.subscription_starts_at &&
        payment.subscription_ends_at
      ) {
        const locked = returningRows<{ subscription_expires_at: Date | null }>(
          await manager.query(
            `SELECT "subscription_expires_at" FROM "companies" WHERE "id" = $1 FOR UPDATE`,
            [payment.company_id],
          ),
        )[0];
        const updated = returningRows<{ subscription_expires_at: Date | null }>(
          await manager.query(
            `UPDATE "companies"
                SET "subscription_expires_at" =
                      "subscription_expires_at" - ($3::timestamptz - $2::timestamptz),
                    "subscription_ended_notice_for" = NULL
              WHERE "id" = $1 AND "subscription_expires_at" IS NOT NULL
              RETURNING "subscription_expires_at"`,
            [payment.company_id, payment.subscription_starts_at, payment.subscription_ends_at],
          ),
        )[0];
        access = {
          before: locked?.subscription_expires_at ?? null,
          after: updated?.subscription_expires_at ?? null,
        };
      }

      await this.audit(manager, "payment.refund", payment.id, {
        before: {
          status: payment.status,
          ...(access ? { subscriptionExpiresAt: access.before } : {}),
        },
        after: {
          status: newStatus,
          reversal: entry,
          ...(access ? { subscriptionExpiresAt: access.after } : {}),
        },
        note: `${eventType} (${payment.kind})`,
      });

      logger.warn(
        {
          eventType,
          paymentId: payment.id,
          companyId: payment.company_id,
          kind: payment.kind,
          newStatus,
          access,
        },
        "PayPal capture reversed — payment marked and access withdrawn",
      );

      // A DENIED capture we never recorded as captured moved no money: nothing to tell.
      if (wasCaptured) {
        const change: RefundAccessChange =
          payment.kind === "spin_addon"
            ? { type: "spins_removed" }
            : payment.kind === "order" && access
              ? {
                  type: "access_reduced",
                  newEndsAt: access.after ? new Date(access.after).toISOString() : null,
                  // Filled in by NotificationService from the invoice row.
                  spinsRemoved: false,
                }
              : { type: "none" };
        notice = {
          paymentId: payment.id,
          companyId: payment.company_id,
          extent: "full",
          reversalId,
          ...refundDisplayAmount("full", resource, payment),
          access: change,
        };
      }
    });

    // After commit. Not awaited and cannot throw: the reversal is recorded whatever
    // happens to the email, and PayPal must get its 2xx.
    if (notice) void this.notificationService.sendRefundProcessed(notice);
  }

  /**
   * Raw insert into `admin_audit_log` rather than AuditService: that service requires a
   * user id and a typed admin action, and this row has no human actor. The FK column is
   * nullable (it is SET NULL on user deletion), which is what makes a system row legal.
   * Written in the caller's transaction so the trail cannot disagree with the change.
   */
  private async audit(
    manager: EntityManager,
    action: "payment.refund" | "payment.partial_refund",
    paymentId: string,
    data: { before: Record<string, unknown>; after: Record<string, unknown>; note: string },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "admin_audit_log"
         ("actor_user_id", "actor_email", "action", "entity_type", "entity_id",
          "before", "after", "note")
       VALUES (NULL, $1, $2, 'payment', $3, $4, $5, $6)`,
      [
        SYSTEM_ACTOR_EMAIL,
        action,
        paymentId,
        JSON.stringify(data.before),
        JSON.stringify(data.after),
        data.note.slice(0, 255),
      ],
    );
  }
}
