import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 3 — the trial identity registry: one free trial per email address and per
 * phone number, ever, across all companies.
 *
 * Design notes that are load-bearing:
 *
 * 1. **No `deleted_at`.** This table must not use soft deletes. TypeORM excludes
 *    soft-deleted rows from `find`, so a soft-deleted row would disappear from
 *    eligibility checks while still holding its slot in the unique index — the
 *    registry would quietly stop blocking. Handing an identifier back is
 *    `released_at`, which is explicit and audited.
 *
 * 2. **`company_id` is nullable, ON DELETE SET NULL.** If a company is ever hard
 *    deleted, the ledger entry must survive it. ON DELETE CASCADE here would mean
 *    "delete your account, get another free trial".
 *
 * 3. **The unique index is partial (`WHERE released_at IS NULL`).** That is what
 *    makes an admin release actually free the identifier, and what
 *    `INSERT ... ON CONFLICT (identifier_hash) WHERE released_at IS NULL DO NOTHING`
 *    infers against. A plain UNIQUE would make a release impossible without deleting
 *    the audit trail.
 *
 * 4. Only `identifier_hash` is unique, not `(identifier_type, identifier_hash)`. The
 *    hash is an HMAC over a type-prefixed string, so the two namespaces cannot
 *    collide, and a single-column index is what ON CONFLICT infers most cleanly.
 */
export class AddTrialIdentities1785466800000 implements MigrationInterface {
  name = "AddTrialIdentities1785466800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      CREATE TABLE "trial_identities" (
        "id"                  uuid           NOT NULL DEFAULT gen_random_uuid(),
        "identifier_type"     varchar(16)    NOT NULL,
        "identifier_hash"     varchar(64)    NOT NULL,
        "identifier_preview"  varchar(64)    NOT NULL,
        "company_id"          uuid,
        "claimed_at"          TIMESTAMPTZ    NOT NULL DEFAULT now(),
        "released_at"         TIMESTAMPTZ,
        "released_by_user_id" uuid,
        "release_reason"      varchar(255),
        CONSTRAINT "pk_trial_identities" PRIMARY KEY ("id"),
        CONSTRAINT "chk_trial_identities_type"
          CHECK ("identifier_type" IN ('email', 'phone')),
        CONSTRAINT "fk_trial_identities_company"
          FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_trial_identities_released_by"
          FOREIGN KEY ("released_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL,
        -- A release must say why. Comping and un-burning an identity are both money
        -- decisions, and an unexplained one is indistinguishable from a mistake.
        CONSTRAINT "chk_trial_identities_release_reason"
          CHECK ("released_at" IS NULL OR "release_reason" IS NOT NULL)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_trial_identities_active"
        ON "trial_identities" ("identifier_hash")
        WHERE "released_at" IS NULL
    `);

    // Admin screens list a company's burned identifiers; without this that is a seq scan.
    await queryRunner.query(`
      CREATE INDEX "idx_trial_identities_company"
        ON "trial_identities" ("company_id")
        WHERE "company_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping this table hands every previously-burned identifier a fresh trial.
    // That is the correct inverse, but it is not recoverable — there is nowhere else
    // the claim history is written down.
    await queryRunner.query(`DROP TABLE IF EXISTS "trial_identities"`);
  }
}
