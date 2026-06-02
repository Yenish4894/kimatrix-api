import { MigrationInterface, QueryRunner } from "typeorm";

export class AddedQrTokenInCompanyEntity1776365656675 implements MigrationInterface {
  name = "AddedQrTokenInCompanyEntity1776365656675";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "uq_customers_company_mobile"`,
    );
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_784c93d70a19f92d77130b8354"`);
    await queryRunner.query(`DROP INDEX "public"."uq_customers_shop_mobile"`);
    await queryRunner.query(`DROP INDEX "public"."uq_customers_fuel_mobile_vehicle"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "qr_token"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "location_accuracy"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "longitude"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "latitude"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "user_agent"`);
    await queryRunner.query(`ALTER TABLE "purchases" DROP COLUMN "ip_address"`);
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "uq_customers_company_mobile" UNIQUE ("mobile", "company_id")`,
    );
  }
}
