import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lucky-draw history survives the erasure of its winner (audit DB-3).
 *
 * `lucky_draws.winner_customer_id` and `winning_purchase_id` were ON DELETE CASCADE, so
 * the expiry purge and account deletion — which delete a company's customers and
 * purchases — silently deleted every draw that company had ever run. A prize dispute
 * after that ("I won in March and was never paid") had no record to check against.
 *
 * Now:
 *  - both FKs are ON DELETE SET NULL (and nullable), so the draw row stays;
 *  - the draw carries a snapshot taken at draw time — winner name, a MASKED mobile (last
 *    four digits only), invoice number, amount and submission time — enough to settle a
 *    dispute without keeping the customer's full contact details;
 *  - existing draws are backfilled from the live rows they still point at.
 *
 * Account deletion additionally NULLs the winner name and masked mobile (see
 * services/customerDataErasure.ts); the expiry purge keeps them, because that company
 * still exists and can still be asked about a draw.
 *
 * Reversible. `down` deletes any draw whose winner has already been erased (the old
 * schema would have cascaded those away, so it cannot hold them), then restores the
 * NOT NULL + CASCADE shape and drops the snapshot.
 */
export class LuckyDrawSurvivesPurge1787112000000 implements MigrationInterface {
  name = "LuckyDrawSurvivesPurge1787112000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "lucky_draws"
        ADD COLUMN IF NOT EXISTS "winner_name"           VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "winner_mobile_masked"  VARCHAR(32),
        ADD COLUMN IF NOT EXISTS "invoice_number"        VARCHAR(64),
        ADD COLUMN IF NOT EXISTS "invoice_amount"        NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS "purchase_submitted_at" TIMESTAMP WITH TIME ZONE
    `);

    // Two plain UPDATE … FROM statements, one per source table: no subqueries in SET.
    // The mask must match maskMobile() in LuckyDrawRepository.
    await queryRunner.query(`
      UPDATE "lucky_draws" d
         SET "winner_name" = cu."full_name",
             "winner_mobile_masked" =
               CASE WHEN length(regexp_replace(cu."mobile", '\\s', '', 'g')) <= 4 THEN '****'
                    ELSE '****' || right(regexp_replace(cu."mobile", '\\s', '', 'g'), 4)
               END
        FROM "customers" cu
       WHERE cu."id" = d."winner_customer_id"
    `);
    await queryRunner.query(`
      UPDATE "lucky_draws" d
         SET "invoice_number" = pu."invoice_number",
             "invoice_amount" = pu."invoice_amount",
             "purchase_submitted_at" = pu."submitted_at"
        FROM "purchases" pu
       WHERE pu."id" = d."winning_purchase_id"
    `);

    // The original FKs were declared inline, so their names are Postgres-generated.
    // Looked up rather than assumed.
    for (const conname of await this.winnerForeignKeys(queryRunner)) {
      await queryRunner.query(`ALTER TABLE "lucky_draws" DROP CONSTRAINT "${conname}"`);
    }
    await queryRunner.query(`
      ALTER TABLE "lucky_draws"
        ALTER COLUMN "winner_customer_id" DROP NOT NULL,
        ALTER COLUMN "winning_purchase_id" DROP NOT NULL,
        ADD CONSTRAINT "fk_lucky_draws_winner_customer"
          FOREIGN KEY ("winner_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL,
        ADD CONSTRAINT "fk_lucky_draws_winning_purchase"
          FOREIGN KEY ("winning_purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL
    `);

    // SET NULL makes every customer/purchase delete look up referencing draws; without
    // these that is a sequential scan of lucky_draws per deleted row.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_lucky_draws_winner_customer"
        ON "lucky_draws" ("winner_customer_id") WHERE "winner_customer_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_lucky_draws_winning_purchase"
        ON "lucky_draws" ("winning_purchase_id") WHERE "winning_purchase_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_lucky_draws_winning_purchase"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_lucky_draws_winner_customer"`);

    // Rows the old schema could not hold: it would have cascaded them away already.
    await queryRunner.query(`
      DELETE FROM "lucky_draws"
       WHERE "winner_customer_id" IS NULL OR "winning_purchase_id" IS NULL
    `);

    for (const conname of await this.winnerForeignKeys(queryRunner)) {
      await queryRunner.query(`ALTER TABLE "lucky_draws" DROP CONSTRAINT "${conname}"`);
    }
    await queryRunner.query(`
      ALTER TABLE "lucky_draws"
        ALTER COLUMN "winner_customer_id" SET NOT NULL,
        ALTER COLUMN "winning_purchase_id" SET NOT NULL,
        ADD CONSTRAINT "lucky_draws_winner_customer_id_fkey"
          FOREIGN KEY ("winner_customer_id") REFERENCES "customers"("id") ON DELETE CASCADE,
        ADD CONSTRAINT "lucky_draws_winning_purchase_id_fkey"
          FOREIGN KEY ("winning_purchase_id") REFERENCES "purchases"("id") ON DELETE CASCADE,
        DROP COLUMN IF EXISTS "purchase_submitted_at",
        DROP COLUMN IF EXISTS "invoice_amount",
        DROP COLUMN IF EXISTS "invoice_number",
        DROP COLUMN IF EXISTS "winner_mobile_masked",
        DROP COLUMN IF EXISTS "winner_name"
    `);
  }

  /** Names of the FK constraints on the two winner columns, whatever they are called. */
  private async winnerForeignKeys(queryRunner: QueryRunner): Promise<string[]> {
    const rows = (await queryRunner.query(`
      SELECT DISTINCT con."conname"
        FROM "pg_constraint" con
        JOIN "pg_attribute" att
          ON att."attrelid" = con."conrelid" AND att."attnum" = ANY (con."conkey")
       WHERE con."conrelid" = '"lucky_draws"'::regclass
         AND con."contype" = 'f'
         AND att."attname" IN ('winner_customer_id', 'winning_purchase_id')
    `)) as { conname: string }[];
    return rows.map((r) => r.conname);
  }
}
