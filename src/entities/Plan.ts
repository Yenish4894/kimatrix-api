import { Entity, Column, OneToMany, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Payment } from "./Payment";

@Entity("plans")
export class Plan extends BaseEntity {
  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ name: "duration_days", type: "int" })
  durationDays!: number;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  price!: string;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @OneToMany(() => Payment, (payment) => payment.plan)
  payments!: Relation<Payment[]>;
}
