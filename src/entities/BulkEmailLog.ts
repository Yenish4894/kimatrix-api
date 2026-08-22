import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { User } from "./User";

@Entity("bulk_email_logs")
@Index("idx_bulk_email_logs_sent_at", ["sentAt"])
export class BulkEmailLog extends BaseEntity {
  @Column({ type: "varchar", length: 255 })
  subject!: string;

  @Column({ type: "text" })
  body!: string;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "sent_by_user_id" })
  sentBy!: Relation<User> | null;

  @Column({ name: "sent_by_email", type: "varchar", length: 255 })
  sentByEmail!: string;

  @Column({ name: "recipient_count", type: "int", default: 0 })
  recipientCount!: number;

  @Column({ name: "recipient_ids", type: "jsonb", default: [] })
  recipientIds!: string[];

  /** Addresses typed in by hand, belonging to no registered company. */
  @Column({ name: "extra_emails", type: "jsonb", default: [] })
  extraEmails!: string[];

  @Column({ name: "sent_at", type: "timestamptz", default: () => "now()" })
  sentAt!: Date;
}
