import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBulkEmailExtraRecipients1785902400000 implements MigrationInterface {
  name = "AddBulkEmailExtraRecipients1785902400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // Addresses typed in by an admin that belong to no registered company. Kept
    // separate from recipient_ids rather than mixed in: one is a foreign key to a
    // company, the other is a bare string, and a history that cannot tell them apart
    // cannot answer "who did we actually email" six months later.
    await queryRunner.query(`
      ALTER TABLE "bulk_email_logs"
        ADD COLUMN IF NOT EXISTS "extra_emails" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bulk_email_logs" DROP COLUMN IF EXISTS "extra_emails"`);
  }
}
