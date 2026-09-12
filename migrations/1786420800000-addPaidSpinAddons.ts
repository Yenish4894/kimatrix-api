import type { MigrationInterface, QueryRunner } from "typeorm";

/** Replaces plan-included draw spins with paid, one-time USD spin add-ons. */
export class AddPaidSpinAddons1786420800000 implements MigrationInterface {
  name = "AddPaidSpinAddons1786420800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_kind"`);
    await queryRunner.query(`
      ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_kind"
        CHECK ("kind" IN ('order', 'subscription_cycle', 'spin_addon'))
    `);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_identifier"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_identifier"
        CHECK (("kind" IN ('order', 'spin_addon') AND "paypal_order_id" IS NOT NULL)
            OR ("kind" = 'subscription_cycle' AND "paypal_sale_id" IS NOT NULL))
    `);

    // `plans.draw_spins` is deliberately left as it is. New payments no longer read it
    // (spins now come from the add-on quantity), so zeroing it changed nothing at runtime
    // while making this migration impossible to undo: `down()` could not restore the
    // per-plan values an admin had set. Captured payments keep their own snapshot.

    // Renewal payments recorded before this release have no period dates, so a company
    // whose current access came from one could not buy spins: the purchase looks for the
    // captured payment whose window contains now. Copy the subscription's current period
    // onto its LATEST renewal only — that period is exactly what the renewal granted,
    // while older renewals' periods can't be recovered reliably and are left alone.
    await queryRunner.query(`
      UPDATE "payments" p
         SET "subscription_starts_at" = s."current_period_start",
             "subscription_ends_at"   = s."current_period_end"
        FROM "subscriptions" s
       WHERE p."subscription_id" = s."id"
         AND p."kind" = 'subscription_cycle'
         AND p."subscription_starts_at" IS NULL
         AND s."current_period_start" IS NOT NULL
         AND s."current_period_end" IS NOT NULL
         AND p."captured_at" = (SELECT max(p2."captured_at") FROM "payments" p2
                                 WHERE p2."subscription_id" = s."id"
                                   AND p2."kind" = 'subscription_cycle')
    `);

    // Group historic payment draws by their paid access window, matching the new
    // period key used by add-ons so extra spins join the same winner pool.
    await queryRunner.query(`
      UPDATE "lucky_draws" d
         SET "period_key" = 'paid:' || floor(extract(epoch FROM p."subscription_starts_at") * 1000)::bigint
                            || ':' || floor(extract(epoch FROM p."subscription_ends_at") * 1000)::bigint
        FROM "payments" p
       WHERE d."payment_id" = p."id"
         AND d."source" = 'payment'
         AND p."subscription_starts_at" IS NOT NULL
         AND p."subscription_ends_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Put historic draws back on the per-payment keys the previous code counts against.
    // Left on the window keys, every spin already used would read as unused after a
    // rollback. (`payment_id` is the payment each draw was recorded against.)
    await queryRunner.query(`
      UPDATE "lucky_draws" SET "period_key" = 'payment:' || "payment_id"
       WHERE "source" = 'payment' AND "payment_id" IS NOT NULL
    `);
    // The kind CHECK below fails if any spin_addon payment exists. That is deliberate:
    // those are real purchases, and rolling back must not silently orphan them.
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_identifier"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_identifier"
        CHECK (("kind" = 'order' AND "paypal_order_id" IS NOT NULL)
            OR ("kind" = 'subscription_cycle' AND "paypal_sale_id" IS NOT NULL))
    `);
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_kind"`);
    await queryRunner.query(`
      ALTER TABLE "payments" ADD CONSTRAINT "chk_payments_kind"
        CHECK ("kind" IN ('order', 'subscription_cycle'))
    `);
  }
}
