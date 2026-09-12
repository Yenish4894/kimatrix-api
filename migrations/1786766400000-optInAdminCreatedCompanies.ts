import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Opts admin-created companies in to bulk email.
 *
 * SuperAdminService.createCompany used to write `promo_email_opt_in = false`, and bulk
 * email now skips opted-out companies, so every company an operator onboarded had
 * silently dropped out of announcements. New ones are created opted in; this fixes the
 * existing ones.
 *
 * WHAT IT CHANGES: exactly the companies that have an `admin_audit_log` row with action
 * 'company.create' (entity_id = the company id as text) and are currently opted out.
 * Self-registered companies are untouched, since they chose their own setting at signup.
 * The changed ids are printed to the migration log, so the change is on record and a
 * precise manual rollback stays possible.
 *
 * DOWN IS BEST-EFFORT. Nothing records which of those companies were opted out before
 * this ran (all of them were, by construction), nor whether an owner has since opted in
 * or out from their profile on purpose. down() sets every admin-created company back to
 * false, which is the pre-migration state only for companies whose owners have not
 * changed the setting since. If precision matters, use the ids from the up() log
 * instead.
 */
export class OptInAdminCreatedCompanies1786766400000 implements MigrationInterface {
  name = "OptInAdminCreatedCompanies1786766400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = (await queryRunner.query(`
      UPDATE "companies" c
         SET "promo_email_opt_in" = true
       WHERE c."promo_email_opt_in" = false
         AND c."id"::text IN (
               SELECT a."entity_id" FROM "admin_audit_log" a
                WHERE a."action" = 'company.create'
             )
      RETURNING c."id"
    `)) as unknown;
    // pg returns [rows, rowCount] for an UPDATE ... RETURNING through TypeORM.
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as
      | { id: string }[]
      | undefined;
    const ids = Array.isArray(rows) ? rows.map((r) => r.id) : [];
    console.warn(
      `[migration ${this.name}] opted in ${ids.length} admin-created compan${ids.length === 1 ? "y" : "ies"}: ${ids.join(", ") || "(none)"}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort; see the class comment. Also reverts owners who opted in themselves.
    await queryRunner.query(`
      UPDATE "companies" c
         SET "promo_email_opt_in" = false
       WHERE c."promo_email_opt_in" = true
         AND c."id"::text IN (
               SELECT a."entity_id" FROM "admin_audit_log" a
                WHERE a."action" = 'company.create'
             )
    `);
  }
}
