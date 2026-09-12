import type { MigrationInterface, QueryRunner } from "typeorm";

/** Adds spin_addon_price_usd to app_settings so the admin can change it without a deploy. */
export class AddSpinAddonPriceSetting1786507200000 implements MigrationInterface {
  name = "AddSpinAddonPriceSetting1786507200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Widen the CHECK constraint to allow the new key.
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "chk_app_settings_key"`,
    );
    await queryRunner.query(`
      ALTER TABLE "app_settings" ADD CONSTRAINT "chk_app_settings_key"
        CHECK ("key" IN ('trial_duration_days', 'platform_currency', 'spin_addon_price_usd'))
    `);

    // Seed the default so getSettings() always finds a row and never falls back to
    // the hardcoded constant in production.
    await queryRunner.query(`
      INSERT INTO "app_settings" ("key", "value")
      VALUES ('spin_addon_price_usd', '3.00')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "app_settings" WHERE "key" = 'spin_addon_price_usd'`);
    await queryRunner.query(
      `ALTER TABLE "app_settings" DROP CONSTRAINT IF EXISTS "chk_app_settings_key"`,
    );
    await queryRunner.query(`
      ALTER TABLE "app_settings" ADD CONSTRAINT "chk_app_settings_key"
        CHECK ("key" IN ('trial_duration_days', 'platform_currency'))
    `);
  }
}
