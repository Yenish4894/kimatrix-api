import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 1 — unify subscription access control, and add the (still inert) trial columns.
 *
 * Background: access was previously enforced in five places that disagreed with each
 * other. The worst of it was `subscription_expires_at IS NULL`, which the backend
 * treated as "admin free override — allow" (middleware/subscription.ts) while the
 * frontend treated it as "locked out" (company/layout.tsx). This migration makes that
 * override EXPLICIT via `is_comped` so the null no longer carries hidden meaning.
 *
 * From here on, `subscription_expires_at = NULL` means exactly one thing: no paid
 * subscription has ever been purchased. Unlimited access is `is_comped`, nothing else.
 *
 * The trial columns are added here too, even though nothing writes them until Phase 3.
 * That keeps `computeEntitlement()` — the highest-risk code in the project — written
 * and tested exactly once, and avoids a second ALTER on `companies` later.
 *
 * Adding NOT NULL columns WITH a default is metadata-only on PG >= 11, so this does
 * not rewrite the table and is safe against production data.
 *
 * WARNING: down() is lossy. Once `is_comped` is dropped, the set of admin-comped
 * companies cannot be reconstructed — the information it was derived from
 * (is_active = true AND subscription_expires_at IS NULL) will by then be
 * indistinguishable from ordinary pending companies.
 */
export class AddEntitlementAndTrialColumns1785369600000 implements MigrationInterface {
  name = "AddEntitlementAndTrialColumns1785369600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The runner wraps all migrations in one transaction, which means this holds an
    // ACCESS EXCLUSIVE lock on `companies`. Fail fast rather than queue behind a
    // long-running transaction and stall the API.
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN "trial_started_at"         TIMESTAMPTZ,
        ADD COLUMN "trial_ends_at"            TIMESTAMPTZ,
        ADD COLUMN "subscription_status"      VARCHAR(24)  NOT NULL DEFAULT 'pending',
        ADD COLUMN "is_comped"                BOOLEAN      NOT NULL DEFAULT false,
        ADD COLUMN "comped_until"             TIMESTAMPTZ,
        ADD COLUMN "comp_reason"              VARCHAR(255),
        ADD COLUMN "comp_granted_by_user_id"  UUID
    `);

    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD CONSTRAINT "FK_companies_comp_granted_by"
        FOREIGN KEY ("comp_granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // THE MOST IMPORTANT STATEMENT IN THIS MIGRATION.
    //
    // These are exactly the rows that today pass `requireActiveSubscription` via
    // its null branch. Convert them to an explicit comp BEFORE the status backfill
    // below reads `is_comped`. Skip this and every admin-activated customer loses
    // access the moment the new code deploys.
    // ─────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      UPDATE "companies"
         SET "is_comped"   = true,
             "comp_reason" = 'Legacy admin activation (migrated)'
       WHERE "is_active" = true
         AND "subscription_expires_at" IS NULL
         AND "deleted_at" IS NULL
    `);

    // Backfill the projection. Mirrors computeEntitlement()'s precedence exactly —
    // see src/utils/entitlement.ts. The trial branches are no-ops right now (the
    // columns were created NULL a few statements ago) but are written out in full
    // so the two stay literally comparable.
    await queryRunner.query(`
      UPDATE "companies" SET "subscription_status" = CASE
        WHEN "is_active" = false AND "deactivated_at" IS NOT NULL              THEN 'deactivated'
        WHEN "is_comped" = true
             AND ("comped_until" IS NULL OR "comped_until" > now())            THEN 'active'
        WHEN "subscription_expires_at" IS NOT NULL
             AND "subscription_expires_at" > now()                             THEN 'active'
        WHEN "trial_ends_at" IS NOT NULL AND "trial_ends_at" > now()           THEN 'trialing'
        WHEN "subscription_expires_at" IS NOT NULL                             THEN 'expired'
        WHEN "trial_ends_at" IS NOT NULL                                       THEN 'trial_expired'
        ELSE 'pending'
      END
    `);

    // CHECK added AFTER the backfill so it can never fail mid-migration.
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD CONSTRAINT "chk_companies_subscription_status"
        CHECK ("subscription_status" IN (
          'pending', 'trialing', 'active', 'trial_expired', 'expired', 'past_due', 'deactivated'
        ))
    `);

    // Plain CREATE INDEX, not CONCURRENTLY — the runner executes migrations inside a
    // transaction and CONCURRENTLY is illegal there. Table size makes this a non-issue.
    await queryRunner.query(`
      CREATE INDEX "idx_companies_subscription_status"
        ON "companies" ("subscription_status")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_companies_trial_ends_at"
        ON "companies" ("trial_ends_at")
        WHERE "trial_ends_at" IS NOT NULL AND "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_companies_subscription_expires_at"
        ON "companies" ("subscription_expires_at")
        WHERE "subscription_expires_at" IS NOT NULL AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_companies_subscription_expires_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_companies_trial_ends_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_companies_subscription_status"`);

    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP CONSTRAINT IF EXISTS "chk_companies_subscription_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP CONSTRAINT IF EXISTS "FK_companies_comp_granted_by"
    `);

    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "comp_granted_by_user_id",
        DROP COLUMN IF EXISTS "comp_reason",
        DROP COLUMN IF EXISTS "comped_until",
        DROP COLUMN IF EXISTS "is_comped",
        DROP COLUMN IF EXISTS "subscription_status",
        DROP COLUMN IF EXISTS "trial_ends_at",
        DROP COLUMN IF EXISTS "trial_started_at"
    `);
  }
}
