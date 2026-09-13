import { AppDataSource } from "data-source";
import { returningRows } from "@/utils/db";

/**
 * `paypal_webhook_events` — the idempotency ledger for PayPal webhooks.
 * See PaypalWebhookService for why the claim is insert-first.
 */
export class PaypalWebhookEventRepository {
  /**
   * Inserts the event row. Returns false when the event id is already known, which is
   * the idempotency guarantee: no row back means another delivery already claimed it.
   */
  async claim(event: {
    eventId: string;
    eventType: string;
    resourceId: string | null;
    createTime: Date | null;
    payload: string;
  }): Promise<boolean> {
    const claimed = returningRows<{ id: string }>(
      await AppDataSource.query(
        `INSERT INTO "paypal_webhook_events"
           ("event_id", "event_type", "resource_id", "create_time", "payload")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("event_id") DO NOTHING
         RETURNING "id"`,
        [event.eventId, event.eventType, event.resourceId, event.createTime, event.payload],
      ),
    );
    return claimed.length > 0;
  }

  /** Deletes the claim so PayPal's retry is processed rather than treated as a duplicate. */
  async release(eventId: string): Promise<void> {
    await AppDataSource.query(`DELETE FROM "paypal_webhook_events" WHERE "event_id" = $1`, [
      eventId,
    ]);
  }

  async markProcessed(eventId: string): Promise<void> {
    await AppDataSource.query(
      `UPDATE "paypal_webhook_events" SET "processed_at" = now() WHERE "event_id" = $1`,
      [eventId],
    );
  }
}
