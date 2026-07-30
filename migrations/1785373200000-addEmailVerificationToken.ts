import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 2 — email verification.
 *
 * `tokens.type` is a plain varchar(32) with no CHECK constraint (see the baseline
 * schema), so introducing the `email_verification` discriminator needs no DDL on
 * the column itself. The only structural change is the partial unique index that
 * mirrors `uq_tokens_active_password_reset`: at most one live verification token
 * per user, so mashing "resend" cannot leave several simultaneously-valid links.
 *
 * `users.email_verified_at` already exists in the baseline and has simply never
 * been written to — nothing to add for it here.
 */
export class AddEmailVerificationToken1785373200000 implements MigrationInterface {
  name = "AddEmailVerificationToken1785373200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defensive: if any rows already carry this type from a partial rollout, collapse
    // them to a single active token per user so the unique index can be created.
    await queryRunner.query(`
      UPDATE "tokens" t
         SET "consumed_at" = now()
       WHERE t."type" = 'email_verification'
         AND t."consumed_at" IS NULL
         AND t."id" <> (
           SELECT t2."id" FROM "tokens" t2
            WHERE t2."user_id" = t."user_id"
              AND t2."type" = 'email_verification'
              AND t2."consumed_at" IS NULL
            ORDER BY t2."created_at" DESC, t2."id" DESC
            LIMIT 1
         )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_tokens_active_email_verification"
        ON "tokens" ("user_id")
        WHERE "type" = 'email_verification' AND "consumed_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tokens_active_email_verification"`);
  }
}
