import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { AdvisoryLockRepository } from "@/repositories/AdvisoryLockRepository";
import { PaymentService } from "@/services/PaymentService";
import { SubscriptionService } from "@/services/SubscriptionService";
import { logger } from "@/utils/logger";
import { runExclusive } from "@/cron/runTracker";

/**
 * Every 10 minutes. A payment is only looked at once it has been stuck for 15 (see
 * RECONCILE_AFTER_MINUTES), so a buyer whose capture timed out gets access, or a
 * failed status, within about 25 minutes instead of never.
 */
const SCHEDULE = "*/10 * * * *";

/** Distinct from every other cron's key so none of them block each other. */
const ADVISORY_LOCK_KEY = 4_820_119;

/** Daily at 03:20 UTC: subscriptions checked against PayPal (see reconcileWithPaypal). */
const SUBSCRIPTION_SCHEDULE = "20 3 * * *";
const SUBSCRIPTION_LOCK_KEY = 4_820_120;

let task: ScheduledTask | null = null;
let subscriptionTask: ScheduledTask | null = null;

/** Same session-lock pattern as reconcileStuckPayments. Null when another instance runs it. */
export async function reconcileSubscriptions(): Promise<Awaited<
  ReturnType<SubscriptionService["reconcileWithPaypal"]>
> | null> {
  const locks = new AdvisoryLockRepository();
  const runner = AppDataSource.createQueryRunner();
  await runner.connect();
  try {
    if (!(await locks.trySessionLock(runner, SUBSCRIPTION_LOCK_KEY))) return null;
    try {
      return await new SubscriptionService().reconcileWithPaypal();
    } finally {
      await locks.sessionUnlock(runner, SUBSCRIPTION_LOCK_KEY);
    }
  } finally {
    await runner.release();
  }
}

/**
 * Settles payments stuck in `capturing`. Returns null when another instance holds the
 * lock.
 *
 * A SESSION advisory lock on one dedicated connection, held for the whole run and
 * released on that same connection. The transaction-scoped pattern the other crons use
 * releases the lock as soon as its tiny transaction commits — before the work starts —
 * and a session lock taken through the pool can be released on a different connection
 * and leak (audit DB-1/DB-2). The work itself is idempotent, so the lock only saves
 * duplicate PayPal calls; the cost is one pinned connection for the few seconds a run
 * takes.
 */
export async function reconcileStuckPayments(): Promise<Awaited<
  ReturnType<PaymentService["reconcileStuckCaptures"]>
> | null> {
  const locks = new AdvisoryLockRepository();
  const runner = AppDataSource.createQueryRunner();
  await runner.connect();
  try {
    const locked = await locks.trySessionLock(runner, ADVISORY_LOCK_KEY);
    if (!locked) {
      logger.debug("Payment reconcile skipped — another instance holds the lock");
      return null;
    }
    try {
      return await new PaymentService().reconcileStuckCaptures();
    } finally {
      await locks.sessionUnlock(runner, ADVISORY_LOCK_KEY);
    }
  } finally {
    await runner.release();
  }
}

export function startPaymentReconcileCron(): void {
  if (task) return;
  task = cron.schedule(
    SCHEDULE,
    async () => {
      // runExclusive skips a tick while the previous run is going and lets shutdown
      // wait for an in-flight run (see server.ts).
      await runExclusive("paymentReconcile", async () => {
        const result = await reconcileStuckPayments();
        if (result && result.completed + result.failed + result.waiting + result.errors > 0) {
          logger.warn(result, "Payment reconcile completed");
        }
      });
    },
    { timezone: "UTC" },
  );
  subscriptionTask = cron.schedule(
    SUBSCRIPTION_SCHEDULE,
    async () => {
      await runExclusive("subscriptionReconcile", async () => {
        const result = await reconcileSubscriptions();
        if (result) logger.info(result, "Subscription reconcile completed");
      });
    },
    { timezone: "UTC" },
  );
  logger.info(
    { schedule: SCHEDULE, subscriptionSchedule: SUBSCRIPTION_SCHEDULE },
    "Payment reconcile cron started",
  );
}

export function stopPaymentReconcileCron(): void {
  if (task) {
    task.stop();
    task = null;
    subscriptionTask?.stop();
    subscriptionTask = null;
    logger.info("Payment reconcile cron stopped");
  }
}
