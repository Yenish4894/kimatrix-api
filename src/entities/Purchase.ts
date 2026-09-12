import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Customer } from "./Customer";
import { User } from "./User";

@Entity("purchases")
// Partial: a voided purchase frees its invoice number so the corrected entry can be
// re-submitted. See migration 1786939200000.
@Index("uq_purchases_company_invoice", ["company", "invoiceNumber"], {
  unique: true,
  where: `"voided_at" IS NULL`,
})
@Index("idx_purchases_customer_submitted", ["customer", "submittedAt"])
@Index("idx_purchases_company_submitted", ["company", "submittedAt"])
export class Purchase extends BaseEntity {
  @ManyToOne(() => Company, (company) => company.purchases, {
    nullable: false,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "company_id" })
  company!: Relation<Company>;

  @ManyToOne(() => Customer, (customer) => customer.purchases, {
    nullable: false,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "customer_id" })
  customer!: Relation<Customer>;

  @Column({ name: "invoice_number", type: "varchar", length: 64 })
  invoiceNumber!: string;

  @Column({
    name: "invoice_amount",
    type: "numeric",
    precision: 14,
    scale: 2,
  })
  invoiceAmount!: string;

  @Column({ name: "full_name_snapshot", type: "varchar", length: 255 })
  fullNameSnapshot!: string;

  @Column({
    name: "vehicle_number_snapshot",
    type: "varchar",
    length: 32,
    nullable: true,
  })
  vehicleNumberSnapshot!: string | null;

  @Column({ name: "submitted_at", type: "timestamptz" })
  submittedAt!: Date;

  @Column({ name: "ip_address", type: "varchar", length: 64, nullable: true })
  ipAddress!: string | null;

  @Column({ name: "user_agent", type: "varchar", length: 512, nullable: true })
  userAgent!: string | null;

  @Column({
    type: "numeric",
    precision: 9,
    scale: 6,
    nullable: true,
  })
  latitude!: string | null;

  @Column({
    type: "numeric",
    precision: 9,
    scale: 6,
    nullable: true,
  })
  longitude!: string | null;

  @Column({
    name: "location_accuracy",
    type: "numeric",
    precision: 10,
    scale: 2,
    nullable: true,
  })
  locationAccuracy!: string | null;

  /** Set when the company voids the entry. Voided rows are kept but count for nothing. */
  @Column({ name: "voided_at", type: "timestamptz", nullable: true })
  voidedAt!: Date | null;

  @Column({ name: "void_reason", type: "varchar", length: 500, nullable: true })
  voidReason!: string | null;

  /** Not loaded by default, so list and detail responses do not carry it. */
  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "voided_by_user_id" })
  voidedBy!: Relation<User> | null;
}
