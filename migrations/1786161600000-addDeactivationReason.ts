import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Records WHY a company was banned.
 *
 * Banning is the single most destructive admin action: it revokes the owner's refresh
 * tokens, cancels billing, blocks login outright, and is the one state where the
 * customer also loses the right to export their own data. Until now it stored nothing
 * but a timestamp and an actor id — and lifting the ban cleared the actor id too, so
 * the only durable trace of a ban vanished the moment it was undone.
 *
 * A real ban had to be reconstructed from pm2 log files three days after the fact, and
 * even then the reason was unknowable. This column plus the paired audit rows make that
 * a lookup instead of an excavation.
 */
export class AddDeactivationReason1786161600000 implements MigrationInterface {
  name = "AddDeactivationReason1786161600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "deactivation_reason" VARCHAR(255)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "deactivation_reason"
    `);
  }
}
