import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Trial and complimentary companies can buy lucky-draw spins (2026-10-06).
 *
 * Until now a spin add-on had to join a paid plan window, so it always had a plan.
 * A spin bought on a free trial or on admin-granted free access has no plan: it joins
 * that trial's or comp's draw period instead, named by `draw_period_key` (the same key
 * `lucky_draws.period_key` uses, e.g. `trial:<epoch ms>` / `comp:<epoch ms>`). Pooling
 * by key rather than by fixed dates is what lets the spins follow an admin extension
 * and keeps past winners of that period out of the draw.
 *
 *  - `payments.plan_id` becomes nullable, but ONLY for a spin add-on (CHECK).
 *  - `payments.draw_period_key` is set exactly for those plan-less add-ons (CHECK).
 *
 * Reversible while no plan-less row exists; `down` refuses otherwise rather than
 * deleting payment history.
 */
export class SpinPurchaseOnTrialAndComp1787198400000 implements MigrationInterface {
  name = "SpinPurchaseOnTrialAndComp1787198400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "draw_period_key" VARCHAR(64),
        ALTER COLUMN "plan_id" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "chk_payments_plan_or_period_spin_addon" CHECK (
          ("plan_id" IS NOT NULL AND "draw_period_key" IS NULL)
          OR ("plan_id" IS NULL AND "draw_period_key" IS NOT NULL AND "kind" = 'spin_addon')
        )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_payments_company_draw_period_key"
        ON "payments" ("company_id", "draw_period_key")
        WHERE "draw_period_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "payments" WHERE "plan_id" IS NULL`,
    )) as { n: number }[];
    const n = rows[0]?.n ?? 0;
    if (n > 0) {
      throw new Error(`Cannot revert: ${n} spin purchase(s) made on a trial or comp have no plan.`);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_company_draw_period_key"`);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_plan_or_period_spin_addon"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        ALTER COLUMN "plan_id" SET NOT NULL,
        DROP COLUMN IF EXISTS "draw_period_key"
    `);
  }
}
