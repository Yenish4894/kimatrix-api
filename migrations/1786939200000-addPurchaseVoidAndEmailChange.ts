import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Two independent additions, shipped together:
 *
 * 1. **Voiding a purchase.** A company can void a wrong entry (typo in the amount, a
 *    test scan). The row is kept, stamped with who voided it, when and why, and is then
 *    left out of totals, reports, exports and the lucky draw.
 *
 *    The old UNIQUE ("company_id", "invoice_number") constraint becomes a PARTIAL unique
 *    index over live rows only, so the corrected purchase can be re-entered under the
 *    same invoice number. The index keeps the old name.
 *
 * 2. **Changing the login email.** `email_change_tokens` holds single-use, hashed,
 *    24-hour tokens, one live token per user (same shape as password-reset tokens).
 *
 * DOWN refuses to run if restoring the full unique constraint would fail, meaning a
 * voided purchase and its re-entry share an invoice number. It also drops the void
 * columns, which turns every voided purchase back into a live one while the customer
 * totals stay decremented. The number of such rows is printed first.
 */
export class AddPurchaseVoidAndEmailChange1786939200000 implements MigrationInterface {
  name = "AddPurchaseVoidAndEmailChange1786939200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "purchases"
        ADD COLUMN "voided_at" TIMESTAMP WITH TIME ZONE NULL,
        ADD COLUMN "void_reason" character varying(500) NULL,
        ADD COLUMN "voided_by_user_id" uuid NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "purchases"
        ADD CONSTRAINT "fk_purchases_voided_by_user"
        FOREIGN KEY ("voided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    // A void always carries its reason, and a reason never appears without a void.
    await queryRunner.query(`
      ALTER TABLE "purchases"
        ADD CONSTRAINT "chk_purchases_void_reason"
        CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL))
    `);
    // FK index (see 1785556800000-addMissingForeignKeyIndexes). Partial, because almost
    // every row is NULL here, and ON DELETE SET NULL only has to find the non-null ones.
    await queryRunner.query(`
      CREATE INDEX "idx_purchases_voided_by_user" ON "purchases" ("voided_by_user_id")
        WHERE "voided_by_user_id" IS NOT NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT "uq_purchases_company_invoice"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_purchases_company_invoice"
        ON "purchases" ("company_id", "invoice_number")
        WHERE "voided_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "email_change_tokens" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id"     uuid NOT NULL,
        "new_email"   character varying(255) NOT NULL,
        "token_hash"  character varying(255) NOT NULL,
        "expires_at"  TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at"     TIMESTAMP WITH TIME ZONE NULL,
        "created_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_change_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "fk_email_change_tokens_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_email_change_tokens_hash" ON "email_change_tokens" ("token_hash")
    `);
    // At most one live link per user, like uq_tokens_active_password_reset. Also serves
    // as the user_id FK index for the live rows.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_email_change_tokens_active_user"
        ON "email_change_tokens" ("user_id") WHERE "used_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_email_change_tokens_user" ON "email_change_tokens" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dupes = (await queryRunner.query(`
      SELECT "company_id", "invoice_number", count(*)::int AS n
        FROM "purchases"
       GROUP BY "company_id", "invoice_number"
      HAVING count(*) > 1
    `)) as { company_id: string; invoice_number: string; n: number }[];
    if (dupes.length > 0) {
      throw new Error(
        `[migration ${this.name}] cannot restore UNIQUE ("company_id", "invoice_number"): ` +
          `${dupes.length} invoice number(s) exist more than once (a voided purchase and its ` +
          `re-entry). Resolve them first: ` +
          dupes
            .slice(0, 20)
            .map((d) => `${d.company_id}/${d.invoice_number} x${d.n}`)
            .join(", "),
      );
    }

    const [voided] = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "purchases" WHERE "voided_at" IS NOT NULL`,
    )) as { n: number }[];
    console.warn(
      `[migration ${this.name}] dropping void columns; ${voided?.n ?? 0} voided purchase(s) become live again (customer totals are NOT restored)`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "email_change_tokens"`);

    await queryRunner.query(`DROP INDEX "uq_purchases_company_invoice"`);
    await queryRunner.query(`
      ALTER TABLE "purchases"
        ADD CONSTRAINT "uq_purchases_company_invoice" UNIQUE ("company_id", "invoice_number")
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_purchases_voided_by_user"`);
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "chk_purchases_void_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT IF EXISTS "fk_purchases_voided_by_user"`,
    );
    await queryRunner.query(`
      ALTER TABLE "purchases"
        DROP COLUMN "voided_by_user_id",
        DROP COLUMN "void_reason",
        DROP COLUMN "voided_at"
    `);
  }
}
