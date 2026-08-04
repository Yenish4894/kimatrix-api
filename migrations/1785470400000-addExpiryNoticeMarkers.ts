import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 4 — send-once markers for the trial/subscription expiry emails.
 *
 * These store **the deadline that was notified about**, not a boolean or a "sent at"
 * timestamp. That choice is what makes the whole thing self-resetting:
 *
 *   WHERE trial_ending_notice_for IS DISTINCT FROM trial_ends_at
 *
 * If an admin extends a trial, `trial_ends_at` moves, the guard stops matching, and
 * the warning fires again for the new deadline — with no code anywhere that has to
 * remember to clear a flag. Same for `subscription_expires_at`: renewing changes it,
 * so a future lapse notifies again. A boolean would have needed a manual reset at
 * every one of those sites, and the one that got forgotten would fail silently by
 * never emailing a customer again.
 *
 * `IS DISTINCT FROM` rather than `<>` because both sides are nullable and `NULL <> x`
 * is NULL, which would make the row never match and the email never send.
 *
 * BullMQ `jobId` dedup alone is not sufficient here and was the original plan: jobs
 * are removed 24h after completion, but the T-2d warning window is 48h wide and the
 * cron runs hourly, so the last 24h of that window would re-enqueue every hour.
 */
export class AddExpiryNoticeMarkers1785470400000 implements MigrationInterface {
  name = "AddExpiryNoticeMarkers1785470400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // Nullable columns with no default: metadata-only on PG >= 11, no table rewrite.
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN "trial_ending_notice_for"        TIMESTAMPTZ,
        ADD COLUMN "trial_ended_notice_for"         TIMESTAMPTZ,
        ADD COLUMN "subscription_ended_notice_for"  TIMESTAMPTZ
    `);

    // Backfill every company that is ALREADY past its deadline, so switching this on
    // does not blast "your trial has ended" at people whose trial ended weeks ago.
    // Only future deadlines should generate mail.
    await queryRunner.query(`
      UPDATE "companies"
         SET "trial_ending_notice_for"       = "trial_ends_at",
             "trial_ended_notice_for"        = "trial_ends_at"
       WHERE "trial_ends_at" IS NOT NULL
         AND "trial_ends_at" <= now()
    `);
    await queryRunner.query(`
      UPDATE "companies"
         SET "subscription_ended_notice_for" = "subscription_expires_at"
       WHERE "subscription_expires_at" IS NOT NULL
         AND "subscription_expires_at" <= now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "trial_ending_notice_for",
        DROP COLUMN IF EXISTS "trial_ended_notice_for",
        DROP COLUMN IF EXISTS "subscription_ended_notice_for"
    `);
  }
}
