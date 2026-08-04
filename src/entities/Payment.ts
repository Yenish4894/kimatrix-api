import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Plan } from "./Plan";

/**
 * `capturing` is the in-flight state: this row has been claimed and a capture request
 * is with PayPal, or was and we never learned the outcome.
 *
 * It exists so the capture HTTP call can happen OUTSIDE a database transaction. A row
 * left in `capturing` means "money may have moved but we have no confirmation" — it is
 * deliberately NOT marked `failed`, because the webhook is the reconciliation path and
 * would skip a failed row.
 *
 * No DB CHECK constraint on this column, so adding a value needs no migration.
 */
export const PAYMENT_STATUSES = [
  "pending",
  "capturing",
  "captured",
  "failed",
  "cancelled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

@Entity("payments")
export class Payment extends BaseEntity {
  @ManyToOne(() => Company, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "company_id" })
  company!: Relation<Company>;

  @ManyToOne(() => Plan, (plan) => plan.payments, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "plan_id" })
  plan!: Relation<Plan>;

  @Index({ unique: true })
  @Column({ name: "paypal_order_id", type: "varchar", length: 64 })
  paypalOrderId!: string;

  @Column({ name: "status", type: "varchar", length: 20 })
  status!: PaymentStatus;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  amount!: string;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @Column({ name: "captured_at", type: "timestamptz", nullable: true })
  capturedAt!: Date | null;

  @Column({ name: "subscription_starts_at", type: "timestamptz", nullable: true })
  subscriptionStartsAt!: Date | null;

  @Column({ name: "subscription_ends_at", type: "timestamptz", nullable: true })
  subscriptionEndsAt!: Date | null;

  @Column({ name: "paypal_response", type: "jsonb", nullable: true })
  paypalResponse!: Record<string, unknown> | null;
}
