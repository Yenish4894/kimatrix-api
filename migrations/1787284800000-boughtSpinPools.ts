import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Bought trial/comp spins get their own draw pool (2026-10-06, follow-up to
 * 1787198400000).
 *
 * 1. Every comp gets a draw window. Comps granted with 0 spins never got
 *    `comp_draw_spins_granted_at`, and spins bought on a comp join that window.
 *    Backfilled to when the comp actually began: the FIRST `company.comp` audit row after
 *    the last `company.uncomp` (an edit of a running comp also writes `company.comp`, so
 *    the latest row would start the window late), else the admin `company.create` (an
 *    onboarded comp), else the company's creation. New grants set it themselves.
 *
 * 2. Bought spins are a separate pool, `buy:<period key>`, next to the period's free
 *    spins. A customer still wins at most once per period across both, so the old
 *    unique index on (company, period_key, winner) no longer covers it. This one keys on
 *    the period with the `buy:` prefix stripped; the eligibility query uses the same
 *    expression, so it can also serve that query.
 */
export class BoughtSpinPools1787284800000 implements MigrationInterface {
  name = "BoughtSpinPools1787284800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "companies" c
         SET "comp_draw_spins_granted_at" = COALESCE(
               (SELECT min(a."created_at") FROM "admin_audit_log" a
                 WHERE a."entity_type" = 'company'
                   AND a."entity_id" = c."id"::text
                   AND a."action" = 'company.comp'
                   AND a."created_at" > COALESCE(
                         (SELECT max(u."created_at") FROM "admin_audit_log" u
                           WHERE u."entity_type" = 'company'
                             AND u."entity_id" = c."id"::text
                             AND u."action" = 'company.uncomp'),
                         '-infinity'::timestamptz)),
               (SELECT min(a."created_at") FROM "admin_audit_log" a
                 WHERE a."entity_type" = 'company'
                   AND a."entity_id" = c."id"::text
                   AND a."action" = 'company.create'),
               c."created_at")
       WHERE c."is_comped" = true
         AND c."comp_draw_spins_granted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_lucky_draws_one_win_per_base_period"
        ON "lucky_draws" ("company_id", (regexp_replace("period_key", '^buy:', '')), "winner_customer_id")
        WHERE "winner_customer_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The backfilled dates stay: the old code ignores a window on a comp with 0 spins.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_lucky_draws_one_win_per_base_period"`);
  }
}
