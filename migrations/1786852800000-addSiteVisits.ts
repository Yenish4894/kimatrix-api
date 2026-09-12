import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Daily visitor counter for the public site.
 *
 * One row per UTC day, incremented by POST /api/metrics/visit with an atomic
 * INSERT ... ON CONFLICT DO UPDATE, so concurrent visits never lose a count and there is
 * no read-modify-write. No personal data is stored: no IP, no user agent, only a count.
 *
 * A brand-new table with no dependants, so down() is exact: dropping it loses only the
 * counts themselves.
 */
export class AddSiteVisits1786852800000 implements MigrationInterface {
  name = "AddSiteVisits1786852800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "site_visits" (
        "day" date NOT NULL,
        "count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_site_visits_day" PRIMARY KEY ("day")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "site_visits"`);
  }
}
