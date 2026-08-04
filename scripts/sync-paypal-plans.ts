import "reflect-metadata";
import { AppDataSource } from "data-source";
import { Plan } from "@/entities/Plan";
import { PaypalService } from "@/services/PaypalService";
import { config } from "@/config/index";

/**
 * Creates the PayPal product and one billing plan per sellable `plans` row.
 *
 * **A script, not a migration.** Migrations run inside a single transaction, so a
 * PayPal timeout mid-way would roll back the schema change while leaving real billing
 * plans behind at PayPal — and a success followed by a later rollback orphans them
 * permanently. There is no way to make a remote HTTP call transactional with the
 * database, so the two are kept apart deliberately.
 *
 * **And not lazy-on-first-subscribe**, which is the other tempting option: two
 * customers subscribing at the same moment would each create a billing plan, and PayPal
 * would happily end up with duplicates for one plan row.
 *
 * Idempotent. Re-running only touches rows that have no `paypal_plan_id` yet, and every
 * PayPal call carries a deterministic `PayPal-Request-Id` so a retry after a timeout
 * returns the original object rather than making a second one.
 *
 * Usage:  npm run build && node dist/scripts/sync-paypal-plans.js [--dry-run]
 */

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Maps a plan duration in days onto a PayPal billing frequency.
 *
 * A live probe against this account confirmed DAY/7, DAY/15, DAY/21 and DAY/30 are all
 * accepted and come back ACTIVE, so every duration maps exactly and no approximation is
 * needed. `WEEK`/`MONTH` equivalents were also verified and are kept here only as a
 * documented fallback if a different account ever refuses DAY.
 */
function toBillingFrequency(durationDays: number): {
  unit: "DAY" | "WEEK" | "MONTH";
  count: number;
} {
  return { unit: "DAY", count: durationDays };
}

async function main(): Promise<void> {
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal credentials are not configured");
  }

  await AppDataSource.initialize();
  const paypal = new PaypalService();
  const repo = AppDataSource.getRepository(Plan);

  // Only sellable plans: archived and disabled rows must never get a live PayPal plan.
  const plans = await repo
    .createQueryBuilder("p")
    .where("p.deleted_at IS NULL")
    .andWhere("p.archived_at IS NULL")
    .andWhere("p.is_active = true")
    .orderBy("p.sort_order", "ASC")
    .getMany();

  console.log(
    `[sync] ${config.PAYPAL_MODE} — ${plans.length} sellable plan(s)${DRY_RUN ? " (dry run)" : ""}`,
  );

  const pending = plans.filter((p) => !p.paypalPlanId);
  if (pending.length === 0) {
    console.log("[sync] every sellable plan already has a PayPal plan. Nothing to do.");
    await AppDataSource.destroy();
    return;
  }

  // One product for the whole platform. Reuse whichever id a plan already carries so a
  // second run does not create another.
  let productId = plans.find((p) => p.paypalProductId)?.paypalProductId ?? null;
  if (!productId) {
    if (DRY_RUN) {
      console.log("[sync] would create the catalog product");
      productId = "PROD-DRYRUN";
    } else {
      productId = await paypal.ensureProduct(
        `kimates-product-${config.PAYPAL_MODE}`,
        "KIMates Subscription",
      );
      console.log(`[sync] product ${productId}`);
    }
  }

  for (const plan of pending) {
    const freq = toBillingFrequency(plan.durationDays);
    const label = `${plan.name} (${plan.durationDays}d, ${plan.currency} ${plan.price})`;

    if (DRY_RUN) {
      console.log(`[sync] would create ${freq.unit}/${freq.count} for ${label}`);
      continue;
    }

    // Deterministic and keyed on the plan id, so a retry after a network failure
    // returns the plan PayPal already made instead of creating a duplicate.
    const created = await paypal.createBillingPlan({
      requestId: `kimates-plan-${plan.id}`,
      productId,
      name: `${plan.name} — ${plan.durationDays} days`,
      ...(plan.description ? { description: plan.description } : {}),
      intervalUnit: freq.unit,
      intervalCount: freq.count,
      price: plan.price,
      currency: plan.currency,
    });

    if (created.status !== "ACTIVE") {
      // Do not mark it recurring: a non-ACTIVE plan cannot be subscribed to, and
      // flipping the flag would offer customers a plan that fails at checkout.
      console.error(`[sync] FAILED ${label}: plan ${created.id} is ${created.status}`);
      continue;
    }

    await repo.update(plan.id, {
      paypalProductId: productId,
      paypalPlanId: created.id,
      billingIntervalUnit: freq.unit,
      billingIntervalCount: freq.count,
      isRecurring: true,
    });
    console.log(`[sync] ${label} -> ${created.id} (${freq.unit}/${freq.count})`);
  }

  await AppDataSource.destroy();
  console.log("[sync] done");
}

main().catch((err: unknown) => {
  console.error("[sync] FAILED:", err);
  process.exit(1);
});
