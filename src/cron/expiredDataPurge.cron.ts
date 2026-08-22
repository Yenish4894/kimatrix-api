import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { EXPIRY_RETENTION_DAYS } from "@/config/retention";
import { config } from "@/config/index";
import { ExpiredDataPurgeService } from "@/services/ExpiredDataPurgeService";
import { logger } from "@/utils/logger";

/**
 * Erases the collected data of companies that lapsed and never came back.
 *
 * Daily rather than hourly: the window is measured in days, so hour-level precision
 * buys nothing and a slower cadence means fewer chances for an irreversible operation
 * to run at an awkward moment.
 *
 * Off unless EXPIRY_PURGE_ENABLED is explicitly true. This is the only irreversible
 * operation in the platform, and a feature that silently starts deleting customer data
 * the moment it deploys is not one anybody should have to discover. It ships dormant
 * and is turned on deliberately, once the dry run has been read.
 */
const SCHEDULE = "20 3 * * *";
const ADVISORY_LOCK_KEY = 4_820_117;

let task: ScheduledTask | null = null;
let running = false;

export async function purgeExpiredCompanyData(): Promise<number> {
  const service = new ExpiredDataPurgeService();

  // One instance at a time. Two concurrent runs would race on the same rows, and
  // while the locked re-check inside `purge` makes that safe, doing the work twice is
  // still pointless.
  const [{ locked }] = (await AppDataSource.manager.query(
    `SELECT pg_try_advisory_lock($1) AS locked`,
    [ADVISORY_LOCK_KEY],
  )) as [{ locked: boolean }];
  if (!locked) return 0;

  try {
    const due = await service.findDue();
    if (due.length === 0) return 0;

    logger.warn(
      {
        count: due.length,
        retentionDays: EXPIRY_RETENTION_DAYS,
        companies: due.map((c) => ({
          id: c.id,
          name: c.name,
          daysExpired: c.days_expired,
          customers: c.customers,
          purchases: c.purchases,
        })),
      },
      "Expiry purge: erasing data for companies past the retention window",
    );

    let purged = 0;
    for (const candidate of due) {
      try {
        // Each company in its own transaction. One failure — a lock timeout, a
        // constraint — must not roll back the companies already handled or stop the
        // rest of the run.
        const result = await service.purge(candidate.id);
        if (result) purged++;
      } catch (err) {
        logger.error(
          { err, companyId: candidate.id, name: candidate.name },
          "Expiry purge failed for one company; continuing with the rest",
        );
      }
    }
    return purged;
  } finally {
    await AppDataSource.manager.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
  }
}

export function startExpiredDataPurgeCron(): void {
  if (task) return;

  if (!config.EXPIRY_PURGE_ENABLED) {
    logger.warn(
      { retentionDays: EXPIRY_RETENTION_DAYS },
      "Expiry purge is DISABLED — no expired company data will be erased. " +
        "Set EXPIRY_PURGE_ENABLED=true to arm it.",
    );
    return;
  }

  task = cron.schedule(
    SCHEDULE,
    async () => {
      if (running) return;
      running = true;
      try {
        const purged = await purgeExpiredCompanyData();
        if (purged > 0) logger.warn({ purged }, "Expiry purge completed");
      } catch (err) {
        logger.error({ err }, "Expiry purge run failed");
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );

  logger.warn(
    { schedule: SCHEDULE, retentionDays: EXPIRY_RETENTION_DAYS },
    "Expiry purge is ARMED — expired company data will be erased on this schedule",
  );
}

export function stopExpiredDataPurgeCron(): void {
  task?.stop();
  task = null;
}
