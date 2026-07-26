import { Entity, Column, ManyToOne, JoinColumn, Index, Unique, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Customer } from "./Customer";

@Entity("purchases")
@Unique("uq_purchases_company_invoice", ["company", "invoiceNumber"])
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
}
