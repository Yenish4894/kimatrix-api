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

export const BUSINESS_TYPES = ["fuel_station", "shop"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

@Entity("companies")
@Check(`"business_type" IN ('fuel_station', 'shop')`)
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

  @Column({ name: "subscription_expires_at", type: "timestamptz", nullable: true })
  subscriptionExpiresAt!: Date | null;

  @OneToMany(() => Customer, (customer) => customer.company)
  customers!: Relation<Customer[]>;

  @OneToMany(() => Purchase, (purchase) => purchase.company)
  purchases!: Relation<Purchase[]>;

  @OneToMany(() => Payment, (payment) => payment.company)
  payments!: Relation<Payment[]>;
}
