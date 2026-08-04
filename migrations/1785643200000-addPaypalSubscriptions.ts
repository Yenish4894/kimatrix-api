import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 6 — PayPal Subscriptions.
 *
 * Cancel, upgrade and downgrade cannot be expressed on the Orders API, which only
 * knows about one-time payments. This adds the schema for the Subscriptions API
 * alongside it.
 *
 * **There is no cutover and no backfill.** An Orders payment cannot be converted into a
 * subscription — that needs a fresh buyer approval we have no way to force. Legacy
 * customers run out the time they already bought and move across when they next
 * subscribe; at that point `start_time` is set to their current expiry so they are
 * neither double-charged nor lose a day. The same mechanism handles converting
 * mid-trial (`start_time = trial_ends_at`), so one code path serves both.
 *
 * `subscription_expires_at` on `companies` remains the single access gate throughout.
 * Recurring subscriptions never gate access directly — they only push that column
 * forward when a payment lands. That is what lets all three eras coexist with no
 * branching in `computeEntitlement`.
 */
export class AddPaypalSubscriptions1785643200000 implements MigrationInterface {
  name = "AddPaypalSubscriptions1785643200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // ── plans: the PayPal side of each plan row ──────────────────────────────
    //
    // A PayPal billing plan is immutable once it has subscribers, which is why the
    // existing plan-versioning rule (price/duration edits archive and supersede rather
    // than mutate) already fits: each plans row maps to exactly one PayPal plan, for
    // its whole life.
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD COLUMN "paypal_product_id"      VARCHAR(64),
        ADD COLUMN "paypal_plan_id"         VARCHAR(64),
        ADD COLUMN "billing_interval_unit"  VARCHAR(8),
        ADD COLUMN "billing_interval_count" INTEGER,
        ADD COLUMN "is_recurring"           BOOLEAN NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD CONSTRAINT "chk_plans_billing_interval_unit"
          CHECK ("billing_interval_unit" IS NULL
                 OR "billing_interval_unit" IN ('DAY', 'WEEK', 'MONTH', 'YEAR'))
    `);
    // A recurring plan is useless without the PayPal ids and cadence to drive it.
    await queryRunner.query(`
      ALTER TABLE "plans"
        ADD CONSTRAINT "chk_plans_recurring_complete"
          CHECK ("is_recurring" = false
                 OR ("paypal_plan_id" IS NOT NULL
                     AND "billing_interval_unit" IS NOT NULL
                     AND "billing_interval_count" IS NOT NULL))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_plans_paypal_plan_id" ON "plans" ("paypal_plan_id")
        WHERE "paypal_plan_id" IS NOT NULL
    `);

    // ── subscriptions ────────────────────────────────────────────────────────
    //
    // Our own state machine rather than a mirror of PayPal's string. Two of these
    // statuses have NO PayPal counterpart and that is exactly the point:
    //   `past_due`       — PayPal is retrying inside a period the customer already paid
    //                      for, so access must NOT lapse yet, but the UI should warn.
    //   `pending_cancel` — we emulate cancel-at-period-end (see below), which PayPal
    //                      does not offer at all.
    await queryRunner.query(`
      CREATE TABLE "subscriptions" (
        "id"                      uuid        NOT NULL DEFAULT gen_random_uuid(),
        "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
        "company_id"              uuid        NOT NULL,
        "plan_id"                 uuid        NOT NULL,
        "paypal_subscription_id"  VARCHAR(64),
        "status"                  VARCHAR(20) NOT NULL DEFAULT 'pending',
        "current_period_start"    TIMESTAMPTZ,
        "current_period_end"      TIMESTAMPTZ,
        "cancelled_at"            TIMESTAMPTZ,
        "cancel_reason"           VARCHAR(255),
        "next_billing_time"       TIMESTAMPTZ,
        "last_event_at"           TIMESTAMPTZ,
        "paypal_response"         jsonb,
        CONSTRAINT "pk_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "chk_subscriptions_status" CHECK ("status" IN (
          'pending', 'active', 'past_due', 'pending_cancel', 'cancelled', 'expired', 'suspended'
        )),
        CONSTRAINT "fk_subscriptions_company"
          FOREIGN KEY ("company_id") REFERENCES "companies" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_subscriptions_plan"
          FOREIGN KEY ("plan_id") REFERENCES "plans" ("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_subscriptions_paypal_id"
        ON "subscriptions" ("paypal_subscription_id")
        WHERE "paypal_subscription_id" IS NOT NULL
    `);
    // One LIVE subscription per company. A partial unique index rather than
    // application logic: two tabs both completing approval would otherwise leave a
    // company paying twice, and no amount of service-layer checking closes that race.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_subscriptions_one_live_per_company"
        ON "subscriptions" ("company_id")
        WHERE "status" IN ('pending', 'active', 'past_due', 'pending_cancel')
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_subscriptions_company" ON "subscriptions" ("company_id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_subscriptions_plan" ON "subscriptions" ("plan_id")`);

    // ── payments becomes the money ledger across BOTH eras ───────────────────
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN "subscription_id" uuid,
        ADD COLUMN "paypal_sale_id"  VARCHAR(64),
        ADD COLUMN "kind"            VARCHAR(20) NOT NULL DEFAULT 'order'
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "fk_payments_subscription"
          FOREIGN KEY ("subscription_id") REFERENCES "subscriptions" ("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_payments_subscription" ON "payments" ("subscription_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "chk_payments_kind" CHECK ("kind" IN ('order', 'subscription_cycle'))
    `);

    // `paypal_order_id` was NOT NULL. A recurring cycle payment has no order id — it
    // has a sale id — so the column has to become nullable, with a CHECK enforcing
    // that a payment carries whichever identifier its kind implies.
    await queryRunner.query(`ALTER TABLE "payments" ALTER COLUMN "paypal_order_id" DROP NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "chk_payments_identifier"
          CHECK (("kind" = 'order' AND "paypal_order_id" IS NOT NULL)
              OR ("kind" = 'subscription_cycle' AND "paypal_sale_id" IS NOT NULL))
    `);

    // THE backstop against double-crediting a billing cycle. PayPal will resend
    // PAYMENT.SALE.COMPLETED on retry, and webhooks are not ordered or deduplicated by
    // the sender. Application-level idempotency is a race; a unique index is not.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_payments_sale_id" ON "payments" ("paypal_sale_id")
        WHERE "paypal_sale_id" IS NOT NULL
    `);

    // The payments.status CHECK was missing entirely — the column has been accepting
    // any string since the table was created.
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "chk_payments_status" CHECK ("status" IN (
          'pending', 'capturing', 'captured', 'failed', 'cancelled', 'refunded'
        ))
    `);

    // ── webhook idempotency ──────────────────────────────────────────────────
    //
    // Insert-first with ON CONFLICT DO NOTHING: if the insert reports no row, this
    // event has been seen and the handler returns without re-applying it. Checking a
    // table and then inserting is the same race the unique index exists to prevent.
    await queryRunner.query(`
      CREATE TABLE "paypal_webhook_events" (
        "id"           uuid        NOT NULL DEFAULT gen_random_uuid(),
        "event_id"     VARCHAR(64) NOT NULL,
        "event_type"   VARCHAR(64) NOT NULL,
        "resource_id"  VARCHAR(64),
        "create_time"  TIMESTAMPTZ,
        "received_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMPTZ,
        "payload"      jsonb,
        CONSTRAINT "pk_paypal_webhook_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_paypal_webhook_events_event_id" UNIQUE ("event_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_paypal_webhook_events_resource"
        ON "paypal_webhook_events" ("resource_id")
    `);

    // ── companies: which subscription is currently live ──────────────────────
    await queryRunner.query(`
      ALTER TABLE "companies" ADD COLUMN "current_subscription_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD CONSTRAINT "fk_companies_current_subscription"
          FOREIGN KEY ("current_subscription_id") REFERENCES "subscriptions" ("id")
          ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_companies_current_subscription"
        ON "companies" ("current_subscription_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "fk_companies_current_subscription"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_companies_current_subscription"`);
    await queryRunner.query(
      `ALTER TABLE "companies" DROP COLUMN IF EXISTS "current_subscription_id"`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "paypal_webhook_events"`);

    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_status"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_payments_sale_id"`);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_identifier"`,
    );
    // Restoring NOT NULL would fail if any recurring-cycle rows exist, so this is
    // deliberately left nullable on the way down.
    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "chk_payments_kind"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_subscription"`);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "fk_payments_subscription"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "subscription_id",
        DROP COLUMN IF EXISTS "paypal_sale_id",
        DROP COLUMN IF EXISTS "kind"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_plans_paypal_plan_id"`);
    await queryRunner.query(
      `ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "chk_plans_recurring_complete"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "chk_plans_billing_interval_unit"`,
    );
    await queryRunner.query(`
      ALTER TABLE "plans"
        DROP COLUMN IF EXISTS "paypal_product_id",
        DROP COLUMN IF EXISTS "paypal_plan_id",
        DROP COLUMN IF EXISTS "billing_interval_unit",
        DROP COLUMN IF EXISTS "billing_interval_count",
        DROP COLUMN IF EXISTS "is_recurring"
    `);
  }
}
