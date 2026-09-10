import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lucky draw: spins are sold as part of a plan and spent on a random pick among the
 * customers who purchased during that plan's window.
 *
 * - `plans.draw_spins` — what the admin says a plan includes. 0 everywhere to start,
 *   so nothing changes on sale until the admin opts a plan in.
 * - `payments.draw_spins` — snapshotted at purchase, like `amount`. Editing a plan
 *   later must never change what a customer already paid for.
 * - `companies.comp_draw_spins` (+ granted-at) — spins an admin grants to a comped
 *   company. The timestamp opens that company's draw window, so purchases from before
 *   the grant are not in the pool.
 * - `lucky_draws` — one row per spin. `period_key` identifies which plan window a
 *   spin belongs to; the unique index makes "a customer cannot win twice in the same
 *   window" a database guarantee, not just an application check.
 */
export class AddLuckyDraw1786334400000 implements MigrationInterface {
  name = "AddLuckyDraw1786334400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD COLUMN IF NOT EXISTS "draw_spins" INTEGER NOT NULL DEFAULT 0,
        ADD CONSTRAINT "chk_plans_draw_spins" CHECK ("draw_spins" BETWEEN 0 AND 100)
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "draw_spins" INTEGER NOT NULL DEFAULT 0,
        ADD CONSTRAINT "chk_payments_draw_spins" CHECK ("draw_spins" >= 0)
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "comp_draw_spins" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "comp_draw_spins_granted_at" TIMESTAMP WITH TIME ZONE,
        ADD CONSTRAINT "chk_companies_comp_draw_spins" CHECK ("comp_draw_spins" BETWEEN 0 AND 100)
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lucky_draws" (
        "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id"          UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
        "period_key"          VARCHAR(64) NOT NULL,
        "source"              VARCHAR(16) NOT NULL CHECK ("source" IN ('payment', 'comp')),
        "payment_id"          UUID REFERENCES "payments"("id") ON DELETE SET NULL,
        "period_start"        TIMESTAMP WITH TIME ZONE NOT NULL,
        "period_end"          TIMESTAMP WITH TIME ZONE,
        "winner_customer_id"  UUID NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
        "winning_purchase_id" UUID NOT NULL REFERENCES "purchases"("id") ON DELETE CASCADE,
        "entries_count"       INTEGER NOT NULL,
        "eligible_customers"  INTEGER NOT NULL,
        "drawn_by_user_id"    UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_lucky_draws_company"
        ON "lucky_draws" ("company_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_lucky_draws_one_win_per_period"
        ON "lucky_draws" ("company_id", "period_key", "winner_customer_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "lucky_draws"`);
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP CONSTRAINT IF EXISTS "chk_companies_comp_draw_spins",
        DROP COLUMN IF EXISTS "comp_draw_spins_granted_at",
        DROP COLUMN IF EXISTS "comp_draw_spins"
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT IF EXISTS "chk_payments_draw_spins",
        DROP COLUMN IF EXISTS "draw_spins"
    `);
    await queryRunner.query(`
      ALTER TABLE "plans"
        DROP CONSTRAINT IF EXISTS "chk_plans_draw_spins",
        DROP COLUMN IF EXISTS "draw_spins"
    `);
  }
}
