import { MigrationInterface, QueryRunner } from "typeorm";

export class SplitCompanyAddress1777200000000 implements MigrationInterface {
  name = "SplitCompanyAddress1777200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
  }
}
