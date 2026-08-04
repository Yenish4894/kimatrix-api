import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { logger } from "@/utils/logger";

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
    const result = (await manager.query(RECONCILE_SQL)) as unknown;
    // node-postgres returns [rows, rowCount] through TypeORM's raw query for UPDATE.
    const changed = Array.isArray(result) ? (result[1] as number) : 0;
    return changed ?? 0;
  });
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
