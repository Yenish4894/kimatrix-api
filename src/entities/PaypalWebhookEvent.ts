import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

/**
 * Every webhook PayPal has delivered, keyed on its event id.
 *
 * Deliberately does NOT extend BaseEntity: no soft delete (a "deleted" event would be
 * reprocessed, which is the one thing this table exists to prevent) and no updated_at.
 *
 * Used insert-first — `INSERT ... ON CONFLICT DO NOTHING RETURNING id`. If no row comes
 * back, this event has already been handled and the handler returns immediately.
 * Checking for existence and then inserting is precisely the race the unique index is
 * there to close, and PayPal retries aggressively enough to hit it.
 */
@Entity("paypal_webhook_events")
export class PaypalWebhookEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "event_id", type: "varchar", length: 64, unique: true })
  eventId!: string;

  @Column({ name: "event_type", type: "varchar", length: 64 })
  eventType!: string;

  /** The subscription or sale id the event is about, for support lookups. */
  @Column({ name: "resource_id", type: "varchar", length: 64, nullable: true })
  resourceId!: string | null;

  /** PayPal's own timestamp — the ordering key, since delivery order is not guaranteed. */
  @Column({ name: "create_time", type: "timestamptz", nullable: true })
  createTime!: Date | null;

  @CreateDateColumn({ name: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  /** Null means received but not successfully applied — worth alerting on. */
  @Column({ name: "processed_at", type: "timestamptz", nullable: true })
  processedAt!: Date | null;

  @Column({ type: "jsonb", nullable: true })
  payload!: Record<string, unknown> | null;
}
