import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Company } from "@/entities/Company";
import { User } from "@/entities/User";

export const TRIAL_IDENTIFIER_TYPES = ["email", "phone"] as const;
export type TrialIdentifierType = (typeof TRIAL_IDENTIFIER_TYPES)[number];

/**
 * The ledger of identifiers that have already consumed their one free trial.
 *
 * **Deliberately does NOT extend BaseEntity.** BaseEntity carries a
 * `@DeleteDateColumn`, and TypeORM silently excludes soft-deleted rows from `find`.
 * A soft-deleted row here would vanish from every eligibility check while still
 * occupying the unique index — the registry would stop blocking and nothing would
 * look wrong. Releasing an identity is an explicit, audited act (`releasedAt`), not
 * a delete.
 *
 * Stores an HMAC, never the identifier itself. A bare SHA-256 of a phone number is
 * not a one-way function in practice: E.164 mobiles are ~10^8–10^9 candidates, which
 * is a few minutes of brute force, so a leak of this table would hand over a
 * plaintext list of every person who ever signed up. The server-side pepper
 * (`TRIAL_IDENTITY_PEPPER`) is what makes the digest unrecoverable without it.
 */
@Entity("trial_identities")
export class TrialIdentity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "identifier_type", type: "varchar", length: 16 })
  identifierType!: TrialIdentifierType;

  /** Hex HMAC-SHA256 of the normalized identifier under the server pepper. */
  @Column({ name: "identifier_hash", type: "varchar", length: 64 })
  identifierHash!: string;

  /**
   * Masked form (`j••••e@gmail.com`, `+2711•••4567`) so support can answer "why was
   * I refused a trial?" without the table holding anything reversible.
   */
  @Column({ name: "identifier_preview", type: "varchar", length: 64 })
  identifierPreview!: string;

  /**
   * Nullable with ON DELETE SET NULL: a hard-deleted company must not take the ledger
   * entry with it, or deleting an account would silently hand back a fresh trial.
   */
  @ManyToOne(() => Company, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "company_id" })
  company!: Company | null;

  @CreateDateColumn({ name: "claimed_at", type: "timestamptz" })
  claimedAt!: Date;

  /** Set by an admin to hand the identifier back. Frees it from the unique index. */
  @Column({ name: "released_at", type: "timestamptz", nullable: true })
  releasedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "released_by_user_id" })
  releasedBy!: User | null;

  /** Required by the service when releasing — it is a money decision, like comping. */
  @Column({ name: "release_reason", type: "varchar", length: 255, nullable: true })
  releaseReason!: string | null;
}
