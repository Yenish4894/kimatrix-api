import { Entity, Column, OneToOne, OneToMany, Check, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { Company } from "./Company";
import { Token } from "./Token";

export const USER_TYPES = ["super_admin", "company"] as const;
export type UserType = (typeof USER_TYPES)[number];

@Entity("users")
@Check(`"user_type" IN ('super_admin', 'company')`)
export class User extends BaseEntity {
  @Column({ type: "varchar", length: 255, unique: true })
  email!: string;

  @Column({ type: "varchar", length: 64, unique: true, nullable: true })
  username!: string | null;

  @Column({ type: "varchar", length: 255, select: false })
  password!: string;

  @Column({ name: "user_type", type: "varchar", length: 32 })
  userType!: UserType;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "email_verified_at", type: "timestamptz", nullable: true })
  emailVerifiedAt!: Date | null;

  @Column({ name: "last_login_at", type: "timestamptz", nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: "password_changed_at", type: "timestamptz", nullable: true })
  passwordChangedAt!: Date | null;

  @OneToOne(() => Company, (company) => company.owner)
  company!: Relation<Company> | null;

  @OneToMany(() => Token, (token) => token.user)
  tokens!: Relation<Token[]>;
}
