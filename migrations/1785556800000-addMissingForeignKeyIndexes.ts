import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Block 4 (database/API audit) — index every foreign key that lacked one.
 *
 * Postgres indexes the *referenced* side of a foreign key automatically (it has to,
 * for the unique constraint) but never the *referencing* side. That leaves two
 * separate problems, and the second one is the surprising one:
 *
 * 1. **Reads.** `payments.company_id` had no index, so "show me this company's payment
 *    history" — the endpoint the billing page will call, and the one PayPal
 *    Subscriptions will lean on hardest — was a sequential scan of the whole payments
 *    table for every request.
 *
 * 2. **Writes on the PARENT table.** Every `DELETE` (and every `UPDATE` of a
 *    referenced key) on `users`, `plans` or `companies` forces Postgres to check each
 *    referencing table for orphans. Without an index that check is a full scan per
 *    child table, per row deleted. With ten unindexed FKs pointing at `users`, deleting
 *    one user meant ten sequential scans — which is exactly the shape of the upcoming
 *    30-day purge job, where it would have been catastrophic rather than merely slow.
 *
 * All are plain single-column indexes on low-cardinality FK columns; they are small and
 * cheap to maintain. `IF NOT EXISTS` so this is safe to re-run.
 *
 * Not using CONCURRENTLY: the migration runner wraps everything in one transaction and
 * `CREATE INDEX CONCURRENTLY` cannot run inside one. These tables are small enough that
 * the brief ACCESS SHARE lock is not worth splitting the migration for — revisit if
 * `purchases` ever needs a new index this way.
 */
export class AddMissingForeignKeyIndexes1785556800000 implements MigrationInterface {
  name = "AddMissingForeignKeyIndexes1785556800000";

  private static readonly INDEXES: [name: string, table: string, column: string][] = [
    // The read hazard: payment history by company, and plan-level revenue reporting.
    ["idx_payments_company", "payments", "company_id"],
    ["idx_payments_plan", "payments", "plan_id"],
    // "Is any company still on this plan?" — checked before archiving a plan.
    ["idx_companies_current_plan", "companies", "current_plan_id"],
    // Audit trails filtered by who did it.
    ["idx_admin_audit_log_actor", "admin_audit_log", "actor_user_id"],
    // The rest are low-traffic lookups, indexed for the parent-side DELETE cost above.
    ["idx_companies_deactivated_by", "companies", "deactivated_by_user_id"],
    ["idx_companies_comp_granted_by", "companies", "comp_granted_by_user_id"],
    ["idx_app_settings_updated_by", "app_settings", "updated_by_user_id"],
    ["idx_trial_identities_released_by", "trial_identities", "released_by_user_id"],
    ["idx_plans_supersedes", "plans", "supersedes_plan_id"],
    ["idx_plans_superseded_by", "plans", "superseded_by_plan_id"],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    for (const [name, table, column] of AddMissingForeignKeyIndexes1785556800000.INDEXES) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" ("${column}")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of AddMissingForeignKeyIndexes1785556800000.INDEXES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}
