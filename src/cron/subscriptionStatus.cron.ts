import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { logger } from "@/utils/logger";
import { runExclusive } from "@/cron/runTracker";
import { AdvisoryLockRepository } from "@/repositories/AdvisoryLockRepository";
import { CompanyRepository, EXPIRY_NOTICE_KINDS } from "@/repositories/CompanyRepository";
import { EmailService } from "@/services/EmailService";

/**
 * Hourly, not daily: a trial ending at 14:00 should not keep showing "active" in the
 * admin list until 03:00 the next morning. Runs at :05 to stay clear of the top of the
 * hour, where everything else tends to fire.
 */
const SCHEDULE = "5 * * * *";

/**
 * Arbitrary but fixed. Two app instances running this concurrently would both do the
 * same idempotent work, which is harmless but wasteful — one takes the lock, the other
 * gets `false` back and skips.
 */
const ADVISORY_LOCK_KEY = 4711_2026;

let task: ScheduledTask | null = null;

/**
 * Projects `computeEntitlement()`'s status into `companies.subscription_status` and
 * keeps `is_active` in step with it. The SQL, and why it is only a cache of
 * `utils/entitlement.ts`, is SUBSCRIPTION_STATUS_RECONCILE_SQL in CompanyRepository.
 */
export async function reconcileSubscriptionStatuses(): Promise<number> {
  const locks = new AdvisoryLockRepository();
  const companyRepository = new CompanyRepository();
  return AppDataSource.transaction(async (manager) => {
    const locked = await locks.tryXactLock(manager, ADVISORY_LOCK_KEY);
    if (!locked) {
      logger.debug("Subscription status reconcile skipped — another instance holds the lock");
      return 0;
    }
    return companyRepository.reconcileSubscriptionStatuses(manager);
  });
}

/**
 * Sends the three expiry notices: two days before a trial ends, when it ends, and
 * when a paid subscription lapses.
 *
 * Claim and send are deliberately split across the transaction boundary:
 *
 *   1. Inside a transaction, atomically claim the due rows and stamp the send-once
 *      marker. Two instances cannot both claim the same company.
 *   2. AFTER that commits, enqueue. Enqueuing inside the transaction would let a
 *      Redis outage roll back the claim, and would queue mail for rows that might
 *      still roll back — customers receiving "your trial has ended" for a trial that
 *      then didn't.
 *   3. If the enqueue throws, put the notice back so the next tick retries. Without
 *      this step a Redis blip permanently consumes the customer's only warning: the
 *      marker is committed, so nothing would ever look at that company again.
 *
 * Each kind is claimed separately so one failing does not suppress the others.
 */
export async function sendExpiryNotices(): Promise<number> {
  const companyRepository = new CompanyRepository();
  const emailService = new EmailService();
  const locks = new AdvisoryLockRepository();
  let sent = 0;

  for (const kind of EXPIRY_NOTICE_KINDS) {
    let targets: Awaited<ReturnType<CompanyRepository["claimExpiryNotices"]>> = [];
    try {
      targets = await AppDataSource.transaction(async (manager) => {
        const locked = await locks.tryXactLockPair(
          manager,
          ADVISORY_LOCK_KEY,
          EXPIRY_NOTICE_KINDS.indexOf(kind),
        );
        if (!locked) return [];
        return companyRepository.claimExpiryNotices(kind, manager);
      });
    } catch (err) {
      logger.error({ err, kind }, "Failed to claim expiry notices");
      continue;
    }

    for (const target of targets) {
      try {
        await emailService.enqueueSubscriptionNotice({
          to: target.owner_email,
          kind,
          companyId: target.company_id,
          companyName: target.company_name,
          deadline: new Date(target.deadline),
        });
        sent++;
      } catch (err) {
        logger.error(
          { err, kind, companyId: target.company_id },
          "Failed to enqueue expiry notice — releasing it for the next tick",
        );
        await companyRepository
          .releaseExpiryNotice(kind, target.company_id)
          .catch((releaseErr: unknown) => {
            // Nothing further to do: the notice is lost for this deadline. Logged
            // loudly because it is the one path where a customer silently gets no
            // warning at all.
            logger.error(
              { err: releaseErr, kind, companyId: target.company_id },
              "Failed to release a claimed expiry notice — this customer will not be warned",
            );
          });
      }
    }
  }

  return sent;
}

export function startSubscriptionStatusCron(): void {
  if (task) return;
  task = cron.schedule(
    SCHEDULE,
    async () => {
      // A previous tick still running means the table is large enough that overlapping
      // runs would queue behind each other's locks for no benefit; runExclusive skips.
      await runExclusive("subscriptionStatus", async () => {
        const changed = await reconcileSubscriptionStatuses();
        if (changed > 0) {
          logger.info({ changed }, "Subscription status reconcile completed");
        }
        // After the reconcile, never before: the notice predicates and the status
        // projection read the same deadlines, and running them in this order means a
        // customer is never emailed "your trial has ended" while the admin list still
        // shows them as trialing.
        const notices = await sendExpiryNotices();
        if (notices > 0) {
          logger.info({ notices }, "Expiry notices enqueued");
        }
      });
    },
    { timezone: "UTC" },
  );
  logger.info({ schedule: SCHEDULE }, "Subscription status cron started");
}

export function stopSubscriptionStatusCron(): void {
  if (task) {
    task.stop();
    task = null;
    logger.info("Subscription status cron stopped");
  }
}
