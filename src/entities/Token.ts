import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { User } from "./User";

export const TOKEN_TYPES = ["refresh", "password_reset", "email_verification"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

@Entity("tokens")
@Index("uq_tokens_active_password_reset", ["user"], {
  unique: true,
  where: "type = 'password_reset' AND consumed_at IS NULL",
})
// Same rapid-fire guard as password reset: at most one live verification link per
// user, so mashing "resend" can't leave a fan of simultaneously-valid tokens.
@Index("uq_tokens_active_email_verification", ["user"], {
  unique: true,
  where: "type = 'email_verification' AND consumed_at IS NULL",
})
export class Token extends BaseEntity {
  @ManyToOne(() => User, (user) => user.tokens, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "user_id" })
  user!: Relation<User>;

  @Column({ type: "varchar", length: 32 })
  type!: TokenType;

  @Index({ unique: true })
  @Column({ name: "token_hash", type: "varchar", length: 255, select: false })
  tokenHash!: string;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @Column({ name: "consumed_at", type: "timestamptz", nullable: true })
  consumedAt!: Date | null;

  @Column({ name: "revoked_at", type: "timestamptz", nullable: true })
  revokedAt!: Date | null;

  @Column({ name: "ip_address", type: "varchar", length: 64, nullable: true })
  ipAddress!: string | null;

  @Column({ name: "user_agent", type: "varchar", length: 512, nullable: true })
  userAgent!: string | null;
}
