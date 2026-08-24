import { MigrationInterface, QueryRunner } from "typeorm";

/** Records what was attached to a bulk send, so the history shows it. */
export class AddBulkEmailAttachment1786075200000 implements MigrationInterface {
  name = "AddBulkEmailAttachment1786075200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "bulk_email_logs" ADD COLUMN IF NOT EXISTS "attachment_filename" varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "bulk_email_logs" ADD COLUMN IF NOT EXISTS "attachment_size" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bulk_email_logs" DROP COLUMN IF EXISTS "attachment_size"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bulk_email_logs" DROP COLUMN IF EXISTS "attachment_filename"`,
    );
  }
}
