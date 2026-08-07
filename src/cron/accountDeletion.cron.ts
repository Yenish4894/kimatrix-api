import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { AccountDeletionService, DELETION_GRACE_DAYS } from "@/services/AccountDeletionService";
import { logger } from "@/utils/logger";

/**
 * Daily, not hourly. The grace period is 30 days, so hour-level precision buys nothing
 * and this is the most destructive job in the system — the less often it runs, the
 * fewer chances it has to be wrong.
 *
 * 03:20 UTC keeps it clear of the token cleanup at 03:00.
 */
const SCHEDULE = "20 3 * * *";

/** Distinct from the subscription cron's key so the two never block each other. */
const ADVISORY_LOCK_KEY = 4711_2027;

let task: ScheduledTask | null = null;
let running = false;

/**
 * Purges accounts whose 30-day grace period has elapsed.
 *
 * Each company is purged in its own transaction, and a failure on one is logged and
 * skipped rather than aborting the batch — one company with unusual data must not
 * indefinitely block erasure for everyone behind it, which is a real obligation and not
 * merely a nicety.
 */
export async function purgeDueAccounts(): Promise<number> {
  const service = new AccountDeletionService();

  const locked = await AppDataSource.transaction(async (manager) => {
    const [row] = (await manager.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [
      ADVISORY_LOCK_KEY,
    ])) as [{ locked: boolean }];
    return row.locked;
  });
  if (!locked) {
    logger.debug("Account purge skipped — another instance holds the lock");
    return 0;
  }

  const due = await service.findDue(new Date());
  if (due.length === 0) return 0;

  logger.warn({ count: due.length, graceDays: DELETION_GRACE_DAYS }, "Purging due accounts");

  let purged = 0;
  for (const companyId of due) {
    try {
      await service.purgeCompany(companyId);
      purged++;
    } catch (err) {
      logger.error({ err, companyId }, "Failed to purge account — skipping, will retry tomorrow");
    }
  }
  return purged;
}

export function startAccountDeletionCron(): void {
  if (task) return;
  task = cron.schedule(
    SCHEDULE,
    async () => {
      if (running) return;
      running = true;
      try {
        const purged = await purgeDueAccounts();
        if (purged > 0) logger.warn({ purged }, "Account purge completed");
      } catch (err) {
        logger.error({ err }, "Account purge cron failed");
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );
  logger.info(
    { schedule: SCHEDULE, graceDays: DELETION_GRACE_DAYS },
    "Account deletion cron started",
  );
}

export function stopAccountDeletionCron(): void {
  if (task) {
    task.stop();
    task = null;
    logger.info("Account deletion cron stopped");
  }
}
