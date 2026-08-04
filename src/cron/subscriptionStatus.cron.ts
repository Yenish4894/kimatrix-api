import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { logger } from "@/utils/logger";
import { affectedRows } from "@/utils/db";
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

/**
 * Projects `computeEntitlement()`'s status into `companies.subscription_status` and
 * keeps `is_active` in step with it.
 *
 * The CASE arms below are the SQL mirror of `utils/entitlement.ts` and must be kept in
 * the same precedence order as that function — deactivated, comped, paid-live,
 * trial-live, paid-lapsed, trial-lapsed, pending. **`entitlement.ts` is the spec; this
 * is a cache.** Nothing gates access on the column, so drift here degrades admin
 * filters and UI badges, never a customer's access.
 *
 * Two deliberate omissions:
 *  - `deactivated_at` is never written. Only an admin sets that, and
 *    `AuthService.login` throws Forbidden on it — an expiring company must still be
 *    able to log in to pay and to export.
 *  - Refresh tokens are never revoked. Same reason.
 */
const RECONCILE_SQL = `
UPDATE "companies" c
   SET "subscription_status" = t.status,
       "is_active" = t.has_access,
       "updated_at" = now()
  FROM (
    SELECT "id",
           CASE
             WHEN "is_active" = false AND "deactivated_at" IS NOT NULL THEN 'deactivated'
             WHEN "is_comped" = true
                  AND ("comped_until" IS NULL OR "comped_until" > now()) THEN 'active'
             WHEN "subscription_expires_at" > now() THEN 'active'
             WHEN "trial_ends_at" > now() THEN 'trialing'
             WHEN "subscription_expires_at" IS NOT NULL THEN 'expired'
             WHEN "trial_ends_at" IS NOT NULL THEN 'trial_expired'
             ELSE 'pending'
           END AS status,
           CASE
             WHEN "is_active" = false AND "deactivated_at" IS NOT NULL THEN false
             WHEN "is_comped" = true
                  AND ("comped_until" IS NULL OR "comped_until" > now()) THEN true
             WHEN "subscription_expires_at" > now() THEN true
             WHEN "trial_ends_at" > now() THEN true
             ELSE false
           END AS has_access
      FROM "companies"
     WHERE "deleted_at" IS NULL
  ) t
 WHERE c."id" = t."id"
   AND c."deleted_at" IS NULL
   -- Guard makes a re-run a genuine no-op rather than a full-table rewrite: without it
   -- every row gets a new updated_at every hour, which is both a lie to anyone reading
   -- that column and needless WAL.
   AND (c."subscription_status" <> t.status OR c."is_active" <> t.has_access)
`;

let task: ScheduledTask | null = null;
let running = false;

export async function reconcileSubscriptionStatuses(): Promise<number> {
  return AppDataSource.transaction(async (manager) => {
    const [{ locked }] = (await manager.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [
      ADVISORY_LOCK_KEY,
    ])) as [{ locked: boolean }];
    if (!locked) {
      logger.debug("Subscription status reconcile skipped — another instance holds the lock");
      return 0;
    }
    return affectedRows(await manager.query(RECONCILE_SQL));
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
  let sent = 0;

  for (const kind of EXPIRY_NOTICE_KINDS) {
    let targets: Awaited<ReturnType<CompanyRepository["claimExpiryNotices"]>> = [];
    try {
      targets = await AppDataSource.transaction(async (manager) => {
        const [{ locked }] = (await manager.query(
          "SELECT pg_try_advisory_xact_lock($1, $2) AS locked",
          [ADVISORY_LOCK_KEY, EXPIRY_NOTICE_KINDS.indexOf(kind)],
        )) as [{ locked: boolean }];
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
      // runs would queue behind each other's locks for no benefit.
      if (running) return;
      running = true;
      try {
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
      } catch (err) {
        logger.error({ err }, "Subscription status reconcile failed");
      } finally {
        running = false;
      }
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
