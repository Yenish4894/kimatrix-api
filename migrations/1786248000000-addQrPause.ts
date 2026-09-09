import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lets a company stop accepting QR submissions without losing its code.
 *
 * A timestamp rather than a boolean: "when did this stop" is the question actually
 * asked when a shop reports that scans are not registering, and a flag cannot answer
 * it. NULL means live, which keeps every existing row correct with no backfill.
 *
 * Deliberately separate from the subscription state. `is_active` and
 * `subscription_status` describe whether the platform will serve this company;
 * this describes whether the company itself wants to be served right now. Merging the
 * two would mean a shop pausing over a quiet weekend was indistinguishable from one
 * that had stopped paying — to the customer at the counter and to support.
 */
export class AddQrPause1786248000000 implements MigrationInterface {
  name = "AddQrPause1786248000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "qr_paused_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "qr_paused_at"
    `);
  }
}
