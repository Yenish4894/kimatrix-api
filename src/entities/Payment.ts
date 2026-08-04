import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Plan } from "./Plan";
import { Subscription } from "./Subscription";

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

export const PAYMENT_KINDS = ["order", "subscription_cycle"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

@Entity("payments")
export class Payment extends BaseEntity {
  @ManyToOne(() => Company, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "company_id" })
  company!: Relation<Company>;

  @ManyToOne(() => Plan, (plan) => plan.payments, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "plan_id" })
  plan!: Relation<Plan>;

  @Index({ unique: true })
  /**
   * Null for a recurring cycle payment, which has a sale id instead. A DB CHECK
   * enforces that each row carries whichever identifier its `kind` implies.
   */
  @Column({ name: "paypal_order_id", type: "varchar", length: 64, nullable: true })
  paypalOrderId!: string | null;

  /**
   * PayPal's id for one recurring charge.
   *
   * Partial-UNIQUE in the database. That index is THE backstop against crediting a
   * billing cycle twice: PayPal resends PAYMENT.SALE.COMPLETED on retry and guarantees
   * neither ordering nor deduplication, so an application-level check is a race and a
   * unique index is not.
   */
  @Column({ name: "paypal_sale_id", type: "varchar", length: 64, nullable: true })
  paypalSaleId!: string | null;

  /** Which era this payment belongs to. `payments` is the ledger for both. */
  @Column({ type: "varchar", length: 20, default: "order" })
  kind!: PaymentKind;

  @ManyToOne(() => Subscription, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "subscription_id" })
  subscription!: Relation<Subscription> | null;

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
