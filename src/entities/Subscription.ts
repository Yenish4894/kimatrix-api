import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from "typeorm";
import { Company } from "@/entities/Company";
import { Plan } from "@/entities/Plan";

export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "past_due",
  "pending_cancel",
  "cancelled",
  "expired",
  "suspended",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * A recurring PayPal subscription.
 *
 * We keep our own state machine rather than mirroring PayPal's status string, because
 * two of these states have no PayPal counterpart and both are load-bearing:
 *
 *  - `past_due` — a payment failed and PayPal is retrying *inside a period the customer
 *    has already paid for*. Access must not lapse yet; the UI should show a warning.
 *    PayPal just says ACTIVE until it eventually suspends.
 *  - `pending_cancel` — PayPal has no cancel-at-period-end. We emulate it: cancel at
 *    PayPal immediately (so nobody is charged again) while deliberately leaving
 *    `companies.subscription_expires_at` alone, so access runs to the end of the period
 *    already paid for. The alternative — deferring the cancel to a cron — risks
 *    charging someone who cancelled, and a billing bug that TAKES money is far worse
 *    than one that grants a few free days.
 *
 * The cost of that choice: PayPal cancellation is terminal, so there is no "resume",
 * only "resubscribe". The UI has to say so.
 */
@Entity("subscriptions")
export class Subscription {
  /**
   * **Deliberately does NOT extend BaseEntity**, which carries a `@DeleteDateColumn`.
   *
   * Two reasons, and the first is the same trap `trial_identities` avoids: TypeORM
   * excludes soft-deleted rows from `find`, so a soft-deleted subscription would
   * disappear from every query while still occupying its slot in the
   * `uq_subscriptions_one_live_per_company` partial index — the company could never
   * subscribe again and nothing would look wrong.
   *
   * Second, this is financial history. A subscription that existed should stay on the
   * record forever; "delete" is not an operation that should be available at all.
   */
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;

  @ManyToOne(() => Company, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "company_id" })
  company!: Relation<Company>;

  @ManyToOne(() => Plan, { nullable: false, onDelete: "RESTRICT" })
  @JoinColumn({ name: "plan_id" })
  plan!: Relation<Plan>;

  /** Null between creating the local row and the buyer approving at PayPal. */
  @Column({ name: "paypal_subscription_id", type: "varchar", length: 64, nullable: true })
  paypalSubscriptionId!: string | null;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status!: SubscriptionState;

  @Column({ name: "current_period_start", type: "timestamptz", nullable: true })
  currentPeriodStart!: Date | null;

  @Column({ name: "current_period_end", type: "timestamptz", nullable: true })
  currentPeriodEnd!: Date | null;

  @Column({ name: "cancelled_at", type: "timestamptz", nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: "cancel_reason", type: "varchar", length: 255, nullable: true })
  cancelReason!: string | null;

  /**
   * Read back from PayPal after approval or revision — never computed locally.
   * PayPal's billing anchor is its own, and a date we calculate will drift from the
   * one it actually charges on.
   */
  @Column({ name: "next_billing_time", type: "timestamptz", nullable: true })
  nextBillingTime!: Date | null;

  /**
   * `create_time` of the last webhook applied.
   *
   * PayPal does not guarantee webhook ordering, so an older event can arrive after a
   * newer one. Ignoring events whose `create_time` predates this is what stops a stale
   * ACTIVATED from resurrecting a subscription the customer has already cancelled.
   */
  @Column({ name: "last_event_at", type: "timestamptz", nullable: true })
  lastEventAt!: Date | null;

  @Column({ name: "paypal_response", type: "jsonb", nullable: true })
  paypalResponse!: Record<string, unknown> | null;
}
