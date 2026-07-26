import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Consolidated baseline schema.
 *
 * This single migration replaces the previous four migrations
 * (createdInitialEntities, addedQrTokenInCompanyEntity, splitCompanyAddress,
 * addPlansAndPayments). It is intended to run against a FRESH database and
 * produces the exact same final schema those four produced in sequence.
 *
 * The statements below are the originals, executed in dependency order, with
 * `uuid-ossp` created first (every table relies on gen_random_uuid()).
 */
export class InitialSchema1777400000000 implements MigrationInterface {
  name = "InitialSchema1777400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Core tables (from createdInitialEntities) ──────────────────────────
    await queryRunner.query(
      `CREATE TABLE "purchases" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "invoice_number" character varying(64) NOT NULL, "invoice_amount" numeric(14,2) NOT NULL, "full_name_snapshot" character varying(255) NOT NULL, "vehicle_number_snapshot" character varying(32), "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL, "company_id" uuid NOT NULL, "customer_id" uuid NOT NULL, CONSTRAINT "uq_purchases_company_invoice" UNIQUE ("company_id", "invoice_number"), CONSTRAINT "PK_1d55032f37a34c6eceacbbca6b8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_purchases_company_submitted" ON "purchases" ("company_id", "submitted_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_purchases_customer_submitted" ON "purchases" ("customer_id", "submitted_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "customers" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "mobile" character varying(20) NOT NULL, "full_name" character varying(255) NOT NULL, "vehicle_number" character varying(32), "total_invoice_amount" numeric(14,2) NOT NULL DEFAULT '0', "submission_count" integer NOT NULL DEFAULT '0', "first_submission_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_submission_at" TIMESTAMP WITH TIME ZONE NOT NULL, "company_id" uuid NOT NULL, CONSTRAINT "PK_133ec679a801fab5e070f73d3ea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_customers_company_total" ON "customers" ("company_id", "total_invoice_amount") `,
    );
    await queryRunner.query(
      `CREATE TABLE "companies" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "name" character varying(255) NOT NULL, "address" text NOT NULL, "registration_number" character varying(128) NOT NULL, "contact_email" character varying(255) NOT NULL, "contact_phone" character varying(20) NOT NULL, "whatsapp_number" character varying(20), "business_type" character varying(32) NOT NULL, "promo_email_opt_in" boolean NOT NULL DEFAULT false, "terms_accepted_at" TIMESTAMP WITH TIME ZONE NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL, "deactivated_at" TIMESTAMP WITH TIME ZONE, "owner_user_id" uuid NOT NULL, "deactivated_by_user_id" uuid, CONSTRAINT "REL_a2e26270eefa893caca40d8de4" UNIQUE ("owner_user_id"), CONSTRAINT "CHK_3a9790760a72ab1dedfe273c65" CHECK ("business_type" IN ('fuel_station', 'shop')), CONSTRAINT "PK_d4bc3e82a314fa9e29f652c2c22" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_21bc5437316daf4448d2db3380" ON "companies" ("registration_number") `,
    );
    await queryRunner.query(
      `CREATE TABLE "tokens" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "type" character varying(32) NOT NULL, "token_hash" character varying(255) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "consumed_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "ip_address" character varying(64), "user_agent" character varying(512), "user_id" uuid NOT NULL, CONSTRAINT "PK_3001e89ada36263dabf1fb6210a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_989478f994a58e1a3b8b9b35a0" ON "tokens" ("token_hash") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_tokens_active_password_reset" ON "tokens" ("user_id") WHERE type = 'password_reset' AND consumed_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "email" character varying(255) NOT NULL, "username" character varying(64), "password" character varying(255) NOT NULL, "user_type" character varying(32) NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "email_verified_at" TIMESTAMP WITH TIME ZONE, "last_login_at" TIMESTAMP WITH TIME ZONE, "password_changed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE ("username"), CONSTRAINT "CHK_6762749b17931c2a6234e7c3cc" CHECK ("user_type" IN ('super_admin', 'company')), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "FK_c594d713693899d85f454ccdebe" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" ADD CONSTRAINT "FK_6b126c5c1c05fc81e93fc8d427a" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_f0e29920aaf871f3eddbea69f0d" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ADD CONSTRAINT "FK_a2e26270eefa893caca40d8de4e" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ADD CONSTRAINT "FK_9112b2ebb7e7192d3c6d2fccd23" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tokens" ADD CONSTRAINT "FK_8769073e38c365f315426554ca5" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ── QR token + purchase metadata + customer uniqueness (from addedQrTokenInCompanyEntity) ──
    await queryRunner.query(`ALTER TABLE "purchases" ADD "ip_address" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "purchases" ADD "user_agent" character varying(512)`);
    await queryRunner.query(`ALTER TABLE "purchases" ADD "latitude" numeric(9,6)`);
    await queryRunner.query(`ALTER TABLE "purchases" ADD "longitude" numeric(9,6)`);
    await queryRunner.query(`ALTER TABLE "purchases" ADD "location_accuracy" numeric(10,2)`);
    await queryRunner.query(
      `ALTER TABLE "companies" ADD "qr_token" character varying(64) NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_customers_fuel_mobile_vehicle" ON "customers" ("company_id", "mobile", "vehicle_number") WHERE vehicle_number IS NOT NULL AND deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_customers_shop_mobile" ON "customers" ("company_id", "mobile") WHERE vehicle_number IS NULL AND deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_784c93d70a19f92d77130b8354" ON "companies" ("qr_token") `,
    );

    // ── Split company address into structured columns (from splitCompanyAddress) ──
    await queryRunner.query(`ALTER TABLE "companies" ADD "street_address" text`);
    await queryRunner.query(`ALTER TABLE "companies" ADD "city" character varying(128)`);
    await queryRunner.query(`ALTER TABLE "companies" ADD "state" character varying(128)`);
    await queryRunner.query(`ALTER TABLE "companies" ADD "country" character varying(128)`);
    await queryRunner.query(`ALTER TABLE "companies" ADD "postal_code" character varying(32)`);
    await queryRunner.query(`
      UPDATE "companies"
      SET
        "street_address" = COALESCE(NULLIF("address", ''), '—'),
        "city" = '—',
        "state" = '—',
        "country" = 'Niger',
        "postal_code" = NULL
      WHERE "street_address" IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "street_address" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "city" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "state" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "country" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "address"`);

    // ── Plans + payments + subscription columns (from addPlansAndPayments) ──
    await queryRunner.query(`
      CREATE TABLE "plans" (
        "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
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
    await queryRunner.query(`
      INSERT INTO "plans" ("name", "duration_days", "price", "currency") VALUES
        ('7 Day Plan',  7,  18.11, 'USD'),
        ('15 Day Plan', 15, 27.16, 'USD'),
        ('21 Day Plan', 21, 39.23, 'USD'),
        ('30 Day Plan', 30, 51.31, 'USD')
    `);
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"                    UUID          NOT NULL DEFAULT gen_random_uuid(),
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
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN "current_plan_id"        UUID        REFERENCES "plans"("id") ON DELETE SET NULL,
        ADD COLUMN "subscription_expires_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Plans + payments + subscription columns
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "subscription_expires_at",
        DROP COLUMN IF EXISTS "current_plan_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);

    // Split company address (restore single address column)
    await queryRunner.query(`ALTER TABLE "companies" ADD "address" text`);
    await queryRunner.query(`
      UPDATE "companies"
      SET "address" = CONCAT_WS(
        ', ',
        NULLIF("street_address", '—'),
        NULLIF("city", '—'),
        NULLIF("state", '—'),
        "country"
      )
      WHERE "address" IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "companies" ALTER COLUMN "address" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "postal_code"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "country"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "state"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "city"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "street_address"`);

    // QR token + purchase metadata + customer uniqueness
    await queryRunner.query(`DROP INDEX "public"."IDX_784c93d70a19f92d77130b8354"`);
    await queryRunner.query(`DROP INDEX "public"."uq_customers_shop_mobile"`);
    await queryRunner.query(`DROP INDEX "public"."uq_customers_fuel_mobile_vehicle"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "qr_token"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "location_accuracy"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "longitude"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "latitude"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "user_agent"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "ip_address"`);

    // Core tables
    await queryRunner.query(
      `ALTER TABLE "tokens" DROP CONSTRAINT "FK_8769073e38c365f315426554ca5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" DROP CONSTRAINT "FK_9112b2ebb7e7192d3c6d2fccd23"`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" DROP CONSTRAINT "FK_a2e26270eefa893caca40d8de4e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "FK_f0e29920aaf871f3eddbea69f0d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT "FK_6b126c5c1c05fc81e93fc8d427a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchases" DROP CONSTRAINT "FK_c594d713693899d85f454ccdebe"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP INDEX "public"."uq_tokens_active_password_reset"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_989478f994a58e1a3b8b9b35a0"`);
    await queryRunner.query(`DROP TABLE "tokens"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_21bc5437316daf4448d2db3380"`);
    await queryRunner.query(`DROP TABLE "companies"`);
    await queryRunner.query(`DROP INDEX "public"."idx_customers_company_total"`);
    await queryRunner.query(`DROP TABLE "customers"`);
    await queryRunner.query(`DROP INDEX "public"."idx_purchases_customer_submitted"`);
    await queryRunner.query(`DROP INDEX "public"."idx_purchases_company_submitted"`);
    await queryRunner.query(`DROP TABLE "purchases"`);
  }
}
