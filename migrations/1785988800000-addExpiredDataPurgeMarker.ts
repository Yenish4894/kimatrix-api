import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Marks when a lapsed company's collected data was erased.
 *
 * Distinct from `anonymized_at`, which records a voluntary account closure. A company
 * that simply stopped paying has not left: its account, login and identity survive so
 * it can come back and start collecting again. Only the customer and purchase records
 * are removed, and this column is how we know that happened rather than the company
 * never having collected anything.
 */
export class AddExpiredDataPurgeMarker1785988800000 implements MigrationInterface {
  name = "AddExpiredDataPurgeMarker1785988800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "data_purged_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "data_purged_at"`);
  }
}
