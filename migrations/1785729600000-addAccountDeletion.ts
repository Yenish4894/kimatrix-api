import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 5b — "export and leave": a 30-day-delayed account erasure.
 *
 * ## Why this anonymises rather than hard-deletes
 *
 * The obvious reading of "purge the company" is `DELETE FROM companies`, and the FK
 * graph refuses it: `customers`, `purchases`, `payments` and `subscriptions` all
 * reference companies with ON DELETE RESTRICT. The tempting fix is to relax those to
 * CASCADE — which would be wrong, because two of those tables are the money ledger.
 * Deleting `payments` destroys the record of what we charged and when, which is
 * precisely the data a business is obliged to keep and the data needed to answer a
 * chargeback six months later.
 *
 * So erasure is split by what the data actually is:
 *
 *  - **Hard-deleted:** `purchases` and `customers`. This is third-party personal data —
 *    names, mobile numbers, vehicle registrations submitted by anonymous members of the
 *    public — collected solely so the merchant could run their loyalty scheme. Once the
 *    merchant leaves there is no basis to keep it, and it is the most sensitive data we
 *    hold.
 *  - **Anonymised in place:** the `companies` row and its owner `users` row. Every
 *    personal field is scrubbed; the row survives so the financial records that point
 *    at it stay valid.
 *  - **Retained untouched:** `payments` and `subscriptions`. Money records, now
 *    referencing an anonymised company.
 *  - **Deliberately NOT touched:** `trial_identities`. Those rows are HMACs, not
 *    personal data, and clearing them would mean "delete your account, get another free
 *    trial" — exactly the abuse the registry exists to stop.
 *
 * ## Why it is request-driven and never automatic
 *
 * `deletion_requested_at` is only ever set by an explicit act. Purging on the basis of
 * an expired subscription would mean a customer who lapses for a month loses everything
 * — the single most destructive default this system could have. Expiry and erasure are
 * unrelated events and the cron treats them that way.
 */
export class AddAccountDeletion1785729600000 implements MigrationInterface {
  name = "AddAccountDeletion1785729600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN "deletion_requested_at"       TIMESTAMPTZ,
        ADD COLUMN "deletion_requested_by_user_id" uuid,
        ADD COLUMN "anonymized_at"               TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD CONSTRAINT "fk_companies_deletion_requested_by"
          FOREIGN KEY ("deletion_requested_by_user_id") REFERENCES "users" ("id")
          ON DELETE SET NULL
    `);

    // Partial: the cron only ever scans pending requests, which is a tiny subset.
    await queryRunner.query(`
      CREATE INDEX "idx_companies_deletion_requested"
        ON "companies" ("deletion_requested_at")
        WHERE "deletion_requested_at" IS NOT NULL AND "anonymized_at" IS NULL
    `);

    // An anonymised company can never be in a pending-deletion state, and cannot be
    // anonymised without having been requested. Cheap invariant, catches a cron bug
    // that would otherwise only show up as a customer's data quietly vanishing.
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD CONSTRAINT "chk_companies_anonymized_requires_request"
          CHECK ("anonymized_at" IS NULL OR "deletion_requested_at" IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "chk_companies_anonymized_requires_request"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_companies_deletion_requested"`);
    await queryRunner.query(
      `ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "fk_companies_deletion_requested_by"`,
    );
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "deletion_requested_at",
        DROP COLUMN IF EXISTS "deletion_requested_by_user_id",
        DROP COLUMN IF EXISTS "anonymized_at"
    `);
  }
}
