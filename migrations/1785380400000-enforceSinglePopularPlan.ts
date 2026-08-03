import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Make "Most Popular" single-occupancy at the database level.
 *
 * `PlanService.clearOtherPopular` runs inside a transaction under READ COMMITTED, so
 * two concurrent creates each marked popular cannot see each other's uncommitted row —
 * both `UPDATE … WHERE id <> self` statements match nothing and both commit with
 * `is_popular = true`. Application logic alone cannot close that window; a partial
 * unique index can.
 *
 * The previous migration also seeded `is_popular = true` on EVERY active 30-day plan.
 * Any deployment with more than one 30-day row therefore starts with two badges, which
 * would make the index creation below fail — so duplicates are collapsed first,
 * keeping the lowest sort order (then oldest) as the winner.
 */
export class EnforceSinglePopularPlan1785380400000 implements MigrationInterface {
  name = "EnforceSinglePopularPlan1785380400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      UPDATE "plans" SET "is_popular" = false
       WHERE "is_popular" = true
         AND "id" <> (
           SELECT "id" FROM "plans"
            WHERE "is_popular" = true AND "deleted_at" IS NULL
            ORDER BY "sort_order" ASC, "created_at" ASC, "id" ASC
            LIMIT 1
         )
    `);

    // Archived and soft-deleted rows are excluded: they are not shown to customers, so
    // they must not consume the single available badge slot.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_plans_single_popular"
        ON "plans" (("is_popular"))
        WHERE "is_popular" = true AND "archived_at" IS NULL AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_plans_single_popular"`);
  }
}
