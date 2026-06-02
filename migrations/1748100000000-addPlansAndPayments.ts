import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlansAndPayments1748100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // plans table
    await queryRunner.query(`
      CREATE TABLE "plans" (
        "id"           UUID         NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "deleted_at"   TIMESTAMPTZ,
        "name"         VARCHAR(100) NOT NULL,
        "duration_days" INT         NOT NULL,
        "price"        DECIMAL(10,2) NOT NULL,
        "currency"     VARCHAR(3)   NOT NULL,
        "is_active"    BOOLEAN      NOT NULL DEFAULT true,
        CONSTRAINT "PK_plans" PRIMARY KEY ("id")
      )
    `);

    // seed the 4 plans
    await queryRunner.query(`
      INSERT INTO "plans" ("name", "duration_days", "price", "currency") VALUES
        ('7 Day Plan',  7,  300.00, 'ZAR'),
        ('15 Day Plan', 15, 450.00, 'ZAR'),
        ('21 Day Plan', 21, 650.00, 'ZAR'),
        ('30 Day Plan', 30, 850.00, 'ZAR')
    `);

    // payments table
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"                    UUID          NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"            TIMESTAMPTZ   NOT NULL DEFAULT now(),
        "updated_at"            TIMESTAMPTZ   NOT NULL DEFAULT now(),
        "deleted_at"            TIMESTAMPTZ,
        "company_id"            UUID          NOT NULL,
        "plan_id"               UUID          NOT NULL,
        "paypal_order_id"       VARCHAR(64)   NOT NULL,
        "status"                VARCHAR(20)   NOT NULL,
        "amount"                DECIMAL(10,2) NOT NULL,
        "currency"              VARCHAR(3)    NOT NULL,
        "captured_at"           TIMESTAMPTZ,
        "subscription_starts_at" TIMESTAMPTZ,
        "subscription_ends_at"  TIMESTAMPTZ,
        "paypal_response"       JSONB,
        CONSTRAINT "PK_payments"           PRIMARY KEY ("id"),
        CONSTRAINT "UQ_payments_order_id"  UNIQUE ("paypal_order_id"),
        CONSTRAINT "FK_payments_company"   FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_payments_plan"      FOREIGN KEY ("plan_id")    REFERENCES "plans"("id")    ON DELETE RESTRICT
      )
    `);

    // subscription columns on companies
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN "current_plan_id"        UUID        REFERENCES "plans"("id") ON DELETE SET NULL,
        ADD COLUMN "subscription_expires_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "subscription_expires_at",
        DROP COLUMN IF EXISTS "current_plan_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);
  }
}
