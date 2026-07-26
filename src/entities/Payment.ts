import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Plan } from "./Plan";

export const PAYMENT_STATUSES = ["pending", "captured", "failed", "cancelled"] as const;
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
