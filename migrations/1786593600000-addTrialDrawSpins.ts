import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Free lucky draw spins for companies on a free trial.
 *
 * One platform setting, `trial_draw_spins`, read live: every running trial gets the
 * current value, so an admin raising it boosts trials already under way. A trial's
 * spins are counted against `trial:<trial_started_at epoch ms>`, so the lucky_draws
 * `source` CHECK gains 'trial'.
 */
export class AddTrialDrawSpins1786593600000 implements MigrationInterface {
  name = "AddTrialDrawSpins1786593600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "chk_app_settings_key"`,
    );
    await queryRunner.query(`
      ALTER TABLE "app_settings" ADD CONSTRAINT "chk_app_settings_key"
        CHECK ("key" IN ('trial_duration_days', 'platform_currency', 'spin_addon_price_usd', 'trial_draw_spins'))
    `);

    // 0 = trials get no spins until an admin picks a number, so deploying this changes
    // nothing for anyone.
    await queryRunner.query(`
      INSERT INTO "app_settings" ("key", "value")
      VALUES ('trial_draw_spins', '0')
      ON CONFLICT ("key") DO NOTHING
    `);

    // The original CHECK was declared inline, so it carries Postgres's generated name.
    await queryRunner.query(
      `ALTER TABLE "lucky_draws" DROP CONSTRAINT IF EXISTS "lucky_draws_source_check"`,
    );
    await queryRunner.query(`
      ALTER TABLE "lucky_draws" ADD CONSTRAINT "lucky_draws_source_check"
        CHECK ("source" IN ('payment', 'comp', 'trial'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fails if any trial draw exists — deliberately: those are real prize draws with
    // real winners, and a rollback must not silently discard that record.
    await queryRunner.query(
      `ALTER TABLE "lucky_draws" DROP CONSTRAINT IF EXISTS "lucky_draws_source_check"`,
    );
    await queryRunner.query(`
      ALTER TABLE "lucky_draws" ADD CONSTRAINT "lucky_draws_source_check"
        CHECK ("source" IN ('payment', 'comp'))
    `);
    await queryRunner.query(`DELETE FROM "app_settings" WHERE "key" = 'trial_draw_spins'`);
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "chk_app_settings_key"`,
    );
    await queryRunner.query(`
      ALTER TABLE "app_settings" ADD CONSTRAINT "chk_app_settings_key"
        CHECK ("key" IN ('trial_duration_days', 'platform_currency', 'spin_addon_price_usd'))
    `);
  }
}
