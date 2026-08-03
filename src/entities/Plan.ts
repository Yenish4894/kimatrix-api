import { Entity, Column, OneToMany, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Payment } from "./Payment";

/**
 * A purchasable subscription plan.
 *
 * Plans are **versioned, never repriced in place.** Changing `price` or `durationDays`
 * archives the current row and creates a successor linked via `supersededByPlanId`.
 *
 * Two reasons this matters:
 *  1. `payments.plan_id` references this row. Mutating the price would rewrite history —
 *     a receipt for a R250 purchase would start claiming R300.
 *  2. PayPal billing plans are immutable; a price change there requires a new PayPal
 *     plan. Mutating our row would put the two permanently out of sync.
 *
 * Cosmetic fields (`name`, `description`, `sortOrder`, `isPopular`) ARE edited in place —
 * they carry no billing meaning.
 */
@Entity("plans")
@Index("idx_plans_active_sort", ["isActive", "sortOrder"])
export class Plan extends BaseEntity {
  @Column({ type: "varchar", length: 100 })
  name!: string;

  /** Optional marketing blurb shown under the plan name. */
  @Column({ type: "varchar", length: 255, nullable: true })
  description!: string | null;

  @Column({ name: "duration_days", type: "int" })
  durationDays!: number;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  price!: string;

  /**
   * Always equals the platform currency in `app_settings`. Stored per-row anyway so a
   * historical payment can be rendered in the currency it was actually charged in.
   */
  @Column({ type: "varchar", length: 3 })
  currency!: string;

  /** Whether the plan can be purchased. Archived plans are always inactive. */
  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  /** Display order on the billing page. Lower first; ties broken by duration. */
  @Column({ name: "sort_order", type: "int", default: 0 })
  sortOrder!: number;

  /**
   * Drives the "Most Popular" badge. Replaces the frontend's hardcoded
   * `durationDays === 30` check, which would have silently un-featured everything the
   * moment an admin created their own plans.
   */
  @Column({ name: "is_popular", type: "boolean", default: false })
  isPopular!: boolean;

  /**
   * Set when a plan is superseded or retired. Archived plans never appear in the
   * public list, but remain readable so old payments and subscriptions still resolve.
   */
  @Column({ name: "archived_at", type: "timestamptz", nullable: true })
  archivedAt!: Date | null;

  /** The plan this one replaced, if it was created by editing price/duration. */
  @ManyToOne(() => Plan, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "supersedes_plan_id" })
  supersedes!: Relation<Plan> | null;

  /** The plan that replaced this one. Non-null implies archived. */
  @ManyToOne(() => Plan, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "superseded_by_plan_id" })
  supersededBy!: Relation<Plan> | null;

  @OneToMany(() => Payment, (payment) => payment.plan)
  payments!: Relation<Payment[]>;
}
