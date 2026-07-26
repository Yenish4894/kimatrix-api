import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Purchase } from "./Purchase";

@Entity("customers")
@Index("uq_customers_shop_mobile", ["company", "mobile"], {
  unique: true,
  where: "vehicle_number IS NULL AND deleted_at IS NULL",
})
@Index("uq_customers_fuel_mobile_vehicle", ["company", "mobile", "vehicleNumber"], {
  unique: true,
  where: "vehicle_number IS NOT NULL AND deleted_at IS NULL",
})
@Index("idx_customers_company_total", ["company", "totalInvoiceAmount"])
export class Customer extends BaseEntity {
  @ManyToOne(() => Company, (company) => company.customers, {
    nullable: false,
    onDelete: "RESTRICT",
  })
  @JoinColumn({ name: "company_id" })
  company!: Relation<Company>;

  @Column({ type: "varchar", length: 20 })
  mobile!: string;

  @Column({ name: "full_name", type: "varchar", length: 255 })
  fullName!: string;

  @Column({
    name: "vehicle_number",
    type: "varchar",
    length: 32,
    nullable: true,
  })
  vehicleNumber!: string | null;

  @Column({
    name: "total_invoice_amount",
    type: "numeric",
    precision: 14,
    scale: 2,
    default: 0,
  })
  totalInvoiceAmount!: string;

  @Column({ name: "submission_count", type: "integer", default: 0 })
  submissionCount!: number;

  @Column({ name: "first_submission_at", type: "timestamptz" })
  firstSubmissionAt!: Date;

  @Column({ name: "last_submission_at", type: "timestamptz" })
  lastSubmissionAt!: Date;

  @OneToMany(() => Purchase, (purchase) => purchase.customer)
  purchases!: Relation<Purchase[]>;
}
