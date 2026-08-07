import {
  Entity,
  Column,
  OneToOne,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
  Check,
  type Relation,
} from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { User } from "./User";
import { Customer } from "./Customer";
import { Purchase } from "./Purchase";
import { Plan } from "./Plan";
import { Payment } from "./Payment";
import { Subscription } from "./Subscription";

export const BUSINESS_TYPES = ["fuel_station", "shop"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/**
 * Materialized projection of `computeEntitlement()` — kept for indexed queries
 * (expiry cron, admin filters, platform stats) and the UI badge.
 *
 * Access control NEVER reads this column. Every gate calls `computeEntitlement()`
 * in real time, so a cron outage or clock skew can't lock a paying customer out.
 */
export const SUBSCRIPTION_STATUSES = [
  "pending",
  "trialing",
  "active",
  "trial_expired",
  "expired",
  "past_due",
  "deactivated",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

@Entity("companies")
@Check(`"business_type" IN ('fuel_station', 'shop')`)
@Check(
  "chk_companies_subscription_status",
  `"subscription_status" IN ('pending', 'trialing', 'active', 'trial_expired', 'expired', 'past_due', 'deactivated')`,
)
export class Company extends BaseEntity {
  @OneToOne(() => User, (user) => user.company, {
    nullable: false,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "owner_user_id" })
  owner!: Relation<User>;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ name: "street_address", type: "text" })
  streetAddress!: string;

  @Column({ type: "varchar", length: 128 })
  city!: string;

  @Column({ type: "varchar", length: 128 })
  state!: string;

  @Column({ type: "varchar", length: 128 })
  country!: string;

  @Column({ name: "postal_code", type: "varchar", length: 32, nullable: true })
  postalCode!: string | null;

  @Index({ unique: true })
  @Column({ name: "registration_number", type: "varchar", length: 128 })
  registrationNumber!: string;

  @Index({ unique: true })
  @Column({ name: "qr_token", type: "varchar", length: 64 })
  qrToken!: string;

  @Column({ name: "contact_email", type: "varchar", length: 255 })
  contactEmail!: string;

  @Column({ name: "contact_phone", type: "varchar", length: 20 })
  contactPhone!: string;

  @Column({
    name: "whatsapp_number",
    type: "varchar",
    length: 20,
    nullable: true,
  })
  whatsappNumber!: string | null;

  @Column({ name: "business_type", type: "varchar", length: 32 })
  businessType!: BusinessType;

  @Column({ name: "promo_email_opt_in", type: "boolean", default: false })
  promoEmailOptIn!: boolean;

  @Column({ name: "terms_accepted_at", type: "timestamptz" })
  termsAcceptedAt!: Date;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "joined_at", type: "timestamptz" })
  joinedAt!: Date;

  @Column({ name: "deactivated_at", type: "timestamptz", nullable: true })
  deactivatedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "deactivated_by_user_id" })
  deactivatedBy!: Relation<User> | null;

  @ManyToOne(() => Plan, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "current_plan_id" })
  currentPlan!: Relation<Plan> | null;

  /**
   * End of PAID time. `null` means no paid subscription has ever been purchased —
   * it does NOT mean unlimited access. Unlimited access is `isComped`, nothing else.
   */
  @Column({ name: "subscription_expires_at", type: "timestamptz", nullable: true })
  subscriptionExpiresAt!: Date | null;

  // ── Trial (written from Phase 3 onward; inert until then) ──

  @Column({ name: "trial_started_at", type: "timestamptz", nullable: true })
  trialStartedAt!: Date | null;

  /**
   * Deliberately NOT folded into `subscriptionExpiresAt`:
   * `PaymentService.computeSubscriptionDates` stacks a new plan on top of a live
   * expiry, so a trial living in that column would gift its remaining days to
   * anyone who subscribes mid-trial.
   */
  @Column({ name: "trial_ends_at", type: "timestamptz", nullable: true })
  trialEndsAt!: Date | null;

  // ── Expiry-notice send-once markers ──
  //
  // Each holds THE DEADLINE THAT WAS NOTIFIED ABOUT, not a boolean or a sent-at time.
  // The cron's guard is `notice_for IS DISTINCT FROM <the deadline>`, so extending a
  // trial or renewing a subscription moves the deadline and re-arms the notice by
  // itself — there is no flag for anyone to forget to reset.

  @Column({ name: "trial_ending_notice_for", type: "timestamptz", nullable: true })
  trialEndingNoticeFor!: Date | null;

  @Column({ name: "trial_ended_notice_for", type: "timestamptz", nullable: true })
  trialEndedNoticeFor!: Date | null;

  @Column({ name: "subscription_ended_notice_for", type: "timestamptz", nullable: true })
  subscriptionEndedNoticeFor!: Date | null;

  // ── Entitlement projection + admin comp ──

  @Column({
    name: "subscription_status",
    type: "varchar",
    length: 24,
    default: "pending",
  })
  subscriptionStatus!: SubscriptionStatus;

  /** The explicit admin free-override. Replaces the old `subscriptionExpiresAt IS NULL` hack. */
  @Column({ name: "is_comped", type: "boolean", default: false })
  isComped!: boolean;

  /** `null` while `isComped` is true means a perpetual comp. */
  @Column({ name: "comped_until", type: "timestamptz", nullable: true })
  compedUntil!: Date | null;

  @Column({ name: "comp_reason", type: "varchar", length: 255, nullable: true })
  compReason!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "comp_granted_by_user_id" })
  compGrantedBy!: Relation<User> | null;

  @OneToMany(() => Customer, (customer) => customer.company)
  customers!: Relation<Customer[]>;

  @OneToMany(() => Purchase, (purchase) => purchase.company)
  purchases!: Relation<Purchase[]>;

  @OneToMany(() => Payment, (payment) => payment.company)
  payments!: Relation<Payment[]>;

  // ── Account deletion ("export and leave") ──
  //
  // Set ONLY by an explicit request. Nothing derives these from an expired
  // subscription: purging on the basis of a lapse would mean a customer who forgets to
  // renew for a month loses everything.

  @Column({ name: "deletion_requested_at", type: "timestamptz", nullable: true })
  deletionRequestedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "deletion_requested_by_user_id" })
  deletionRequestedBy!: Relation<User> | null;

  /**
   * When personal data was erased. The row survives anonymisation so the payment and
   * subscription records that reference it stay valid — those are the money ledger and
   * are deliberately retained.
   */
  @Column({ name: "anonymized_at", type: "timestamptz", nullable: true })
  anonymizedAt!: Date | null;

  /**
   * The live recurring subscription, if any.
   *
   * Deliberately NOT an access gate. Access is still decided entirely by
   * `subscription_expires_at` via computeEntitlement — a recurring subscription only
   * ever pushes that column forward when a payment lands. That separation is what lets
   * the legacy Orders era, the trial era and the recurring era coexist with no
   * branching in the gate, and it means a missed webhook cannot lock out someone who
   * has actually paid.
   */
  @ManyToOne(() => Subscription, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "current_subscription_id" })
  currentSubscription!: Relation<Subscription> | null;
}
