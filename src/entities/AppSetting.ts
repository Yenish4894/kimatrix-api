import { Entity, Column, ManyToOne, JoinColumn, Index, type Relation } from "typeorm";
import { BaseEntity } from "./BaseEntity";
import { User } from "./User";

export const APP_SETTING_KEYS = ["trial_duration_days", "platform_currency"] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

/**
 * Platform-wide settings an admin can change without a deploy.
 *
 * Deliberately a narrow key/value table rather than columns on a singleton row: the
 * set of settings will grow, and each addition would otherwise need a migration. The
 * keys are constrained by a CHECK so a typo can't silently create a dead setting that
 * reads back as "unset" forever.
 *
 * Values are stored as text and parsed by `SettingsService`, which owns the defaults.
 */
@Entity("app_settings")
@Index("uq_app_settings_key", ["key"], { unique: true })
export class AppSetting extends BaseEntity {
  @Column({ type: "varchar", length: 64 })
  key!: AppSettingKey;

  @Column({ type: "varchar", length: 255 })
  value!: string;

  @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "updated_by_user_id" })
  updatedBy!: Relation<User> | null;
}
