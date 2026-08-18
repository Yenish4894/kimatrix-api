import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBulkEmailLogs1785816000000 implements MigrationInterface {
  name = "AddBulkEmailLogs1785816000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      CREATE TABLE "bulk_email_logs" (
        "id"               uuid          NOT NULL DEFAULT gen_random_uuid(),
        "subject"          varchar(255)  NOT NULL,
        "body"             text          NOT NULL,
        "sent_by_user_id"  uuid,
        "sent_by_email"    varchar(255)  NOT NULL,
        "recipient_count"  integer       NOT NULL DEFAULT 0,
        "recipient_ids"    jsonb         NOT NULL DEFAULT '[]',
        "sent_at"          timestamptz   NOT NULL DEFAULT now(),
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        "deleted_at"       timestamptz,
        CONSTRAINT "pk_bulk_email_logs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_bulk_email_logs_user"
          FOREIGN KEY ("sent_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_bulk_email_logs_sent_at" ON "bulk_email_logs" ("sent_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_bulk_email_logs_sent_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bulk_email_logs"`);
  }
}
