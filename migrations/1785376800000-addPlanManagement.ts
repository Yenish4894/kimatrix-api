import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Admin-managed plans, platform settings, and an audit trail.
 *
 * Three things happen here:
 *
 * 1. `plans` gains presentation fields (description, sort_order, is_popular) and
 *    versioning fields (archived_at, supersedes/superseded_by). Plans are versioned
 *    rather than repriced in place: `payments.plan_id` references these rows, so
 *    mutating a price would rewrite historical receipts, and PayPal billing plans are
 *    immutable so an in-place edit would desync us from them permanently.
 *
 * 2. `app_settings` — narrow key/value table so an admin can change the trial length
 *    and platform currency without a deploy. Keys are CHECK-constrained so a typo
 *    can't create a dead setting that silently reads back as "unset".
 *
 * 3. `admin_audit_log` — append-only record of plan/pricing changes. `be-decisions.md`
 *    flags the absence of any audit table as a known gap; this closes it where it
 *    matters most.
 *
 * Seeds the trial length at 7 days and derives the platform currency from whatever the
 * existing plans already use, so nothing changes behaviourally on deploy.
 */
export class AddPlanManagement1785376800000 implements MigrationInterface {
  name = "AddPlanManagement1785376800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // ── plans ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD COLUMN "description"           VARCHAR(255),
        ADD COLUMN "sort_order"            INT         NOT NULL DEFAULT 0,
        ADD COLUMN "is_popular"            BOOLEAN     NOT NULL DEFAULT false,
        ADD COLUMN "archived_at"           TIMESTAMPTZ,
        ADD COLUMN "supersedes_plan_id"    UUID,
        ADD COLUMN "superseded_by_plan_id" UUID
    `);

    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD CONSTRAINT "FK_plans_supersedes"
          FOREIGN KEY ("supersedes_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL,
        ADD CONSTRAINT "FK_plans_superseded_by"
          FOREIGN KEY ("superseded_by_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL
    `);

    // An archived plan must never be purchasable. Enforced in the DB because the
    // consequence of getting it wrong is selling a retired price.
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD CONSTRAINT "chk_plans_archived_not_active"
        CHECK ("archived_at" IS NULL OR "is_active" = false)
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_plans_active_sort" ON "plans" ("is_active", "sort_order")
    `);

    // Give the seeded plans a deterministic order (shortest first) so the billing page
    // doesn't reorder itself once sort_order starts being honoured.
    await queryRunner.query(`
      UPDATE "plans" SET "sort_order" = "duration_days"
    `);

    // Preserve the behaviour the frontend previously hardcoded (30-day = "Most
    // Popular"), so the badge doesn't silently disappear on deploy.
    await queryRunner.query(`
      UPDATE "plans" SET "is_popular" = true
       WHERE "duration_days" = 30 AND "is_active" = true AND "deleted_at" IS NULL
    `);

    // ── app_settings ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "app_settings" (
        "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "deleted_at"         TIMESTAMPTZ,
        "key"                VARCHAR(64)  NOT NULL,
        "value"              VARCHAR(255) NOT NULL,
        "updated_by_user_id" UUID,
        CONSTRAINT "PK_app_settings" PRIMARY KEY ("id"),
        CONSTRAINT "FK_app_settings_updated_by"
          FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "chk_app_settings_key"
          CHECK ("key" IN ('trial_duration_days', 'platform_currency'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_app_settings_key" ON "app_settings" ("key")
    `);

    // Trial length: 7 days. Changing this later only affects trials that start
    // afterwards — `companies.trial_ends_at` is stamped once, when the trial begins.
    await queryRunner.query(`
      INSERT INTO "app_settings" ("key", "value") VALUES ('trial_duration_days', '7')
    `);

    // Derive the platform currency from the existing plans rather than assuming USD,
    // so this cannot silently redenominate a live catalogue.
    await queryRunner.query(`
      INSERT INTO "app_settings" ("key", "value")
      SELECT 'platform_currency', COALESCE(
        (SELECT "currency" FROM "plans"
          WHERE "deleted_at" IS NULL
          GROUP BY "currency" ORDER BY count(*) DESC, "currency" ASC LIMIT 1),
        'USD'
      )
    `);

    // ── admin_audit_log ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "admin_audit_log" (
        "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
        "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMPTZ,
        "actor_user_id" UUID,
        "actor_email"   VARCHAR(255) NOT NULL,
        "action"        VARCHAR(48)  NOT NULL,
        "entity_type"   VARCHAR(32)  NOT NULL,
        "entity_id"     VARCHAR(64)  NOT NULL,
        "before"        JSONB,
        "after"         JSONB,
        "note"          VARCHAR(255),
        CONSTRAINT "PK_admin_audit_log" PRIMARY KEY ("id"),
        CONSTRAINT "FK_admin_audit_actor"
          FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_admin_audit_entity" ON "admin_audit_log" ("entity_type", "entity_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_admin_audit_created" ON "admin_audit_log" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "admin_audit_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "app_settings"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_plans_active_sort"`);
    await queryRunner.query(`
      ALTER TABLE "plans"
        DROP CONSTRAINT IF EXISTS "chk_plans_archived_not_active",
        DROP CONSTRAINT IF EXISTS "FK_plans_superseded_by",
        DROP CONSTRAINT IF EXISTS "FK_plans_supersedes"
    `);
    await queryRunner.query(`
      ALTER TABLE "plans"
        DROP COLUMN IF EXISTS "superseded_by_plan_id",
        DROP COLUMN IF EXISTS "supersedes_plan_id",
        DROP COLUMN IF EXISTS "archived_at",
        DROP COLUMN IF EXISTS "is_popular",
        DROP COLUMN IF EXISTS "sort_order",
        DROP COLUMN IF EXISTS "description"
    `);
  }
}
