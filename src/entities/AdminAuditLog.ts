import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { User } from "./User";

export const AUDIT_ACTIONS = [
  "plan.create",
  "plan.update",
  "plan.version",
  "plan.enable",
  "plan.disable",
  "plan.archive",
  "setting.update",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Append-only record of money-affecting admin actions.
 *
 * Scoped deliberately narrowly to plan and settings changes rather than trying to be a
 * general audit system — pricing is where "who set this, and when?" actually gets
 * asked. `be-decisions.md` flags the absence of any audit table as a known gap; this
 * closes it for the highest-value case without committing to logging everything.
 *
 * `actor` is nullable only so deleting a user cannot destroy the trail. `actorEmail`
 * is denormalized for the same reason — the log must stay readable after the account
 * it refers to is gone.
 */
@Entity("admin_audit_log")
@Index("idx_admin_audit_entity", ["entityType", "entityId"])
@Index("idx_admin_audit_created", ["createdAt"])
export class AdminAuditLog extends BaseEntity {
  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "actor_user_id" })
  actor!: Relation<User> | null;

  @Column({ name: "actor_email", type: "varchar", length: 255 })
  actorEmail!: string;

  @Column({ type: "varchar", length: 48 })
  action!: AuditAction;

  @Column({ name: "entity_type", type: "varchar", length: 32 })
  entityType!: string;

  /** Not an FK — the referenced row may later be archived or removed. */
  @Column({ name: "entity_id", type: "varchar", length: 64 })
  entityId!: string;

  /** Values before the change. Null for creates. */
  @Column({ type: "jsonb", nullable: true })
  before!: Record<string, unknown> | null;

  /** Values after the change. Null for pure deletes. */
  @Column({ type: "jsonb", nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  note!: string | null;
}
