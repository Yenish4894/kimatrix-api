import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the marker for the pre-expiry warning on PAID plans.
 *
 * Trials warned before lapsing; paid subscriptions did not. A paying customer's plan
 * ran out with no notice at all — the first they heard was the email telling them it
 * had already stopped. That is the customer most worth keeping.
 */
export class AddSubscriptionEndingNotice1785902400000 implements MigrationInterface {
  name = "AddSubscriptionEndingNotice1785902400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "subscription_ending_notice_for" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "companies" DROP COLUMN IF EXISTS "subscription_ending_notice_for"`,
    );
  }
}
