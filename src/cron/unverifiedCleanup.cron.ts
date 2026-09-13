import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import {
  UnverifiedSignupRepository,
  UNVERIFIED_MIN_AGE_DAYS,
} from "@/repositories/UnverifiedSignupRepository";
import { logger } from "@/utils/logger";

/**
 * Nightly removal of signups that never verified their email.
 *
 * Daily, because the threshold is a week and hour-level precision buys nothing.
 * 03:40 UTC stays clear of token cleanup (03:00) and the two purges (03:20), so the
 * destructive jobs never contend for the same rows or connections.
 *
 * Always SCHEDULED, but only DELETES when UNVERIFIED_CLEANUP_ENABLED=true. Unlike the
 * expiry purge (which does not schedule at all when off), the dry run is the point:
 * each night it logs exactly what it would remove, so the switch is flipped after
 * reading real output rather than on faith.
 */
const SCHEDULE = "40 3 * * *";

/** Distinct from every other cron's key so none of them block each other. */
const ADVISORY_LOCK_KEY = 4_820_118;

/**
 * Bounds one run. A backlog clears over a few nights instead of one long run holding
 * locks, and a predicate bug can only ever cost this many rows before someone reads
 * the log.
 */
const MAX_PER_RUN = 200;

let task: ScheduledTask | null = null;
let running = false;

export interface UnverifiedCleanupSummary {
  mode: "dry-run" | "enabled";
  candidates: number;
  removed: number;
  /** Stopped qualifying between listing and locking — verified, paid, etc. */
  skipped: number;
  failed: number;
}

export async function cleanupUnverifiedSignups(
  enabled: boolean = config.UNVERIFIED_CLEANUP_ENABLED,
): Promise<UnverifiedCleanupSummary | null> {
  const repository = new UnverifiedSignupRepository();

  // Session-level lock on a pinned connection — the same pattern as the expiry purge,
  // for the same reason: lock and unlock through the pool can land on different
  // connections, leak the lock, and silently disable every later run.
  const lockRunner = AppDataSource.createQueryRunner();
  await lockRunner.connect();
  try {
    const [{ locked }] = (await lockRunner.query(`SELECT pg_try_advisory_lock($1) AS locked`, [
      ADVISORY_LOCK_KEY,
    ])) as [{ locked: boolean }];
    if (!locked) {
      logger.debug("Unverified-signup cleanup skipped — another instance holds the lock");
      return null;
    }
    try {
      return await runCleanup(repository, enabled);
    } finally {
      await lockRunner.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await lockRunner.release();
  }
}

async function runCleanup(
  repository: UnverifiedSignupRepository,
  enabled: boolean,
): Promise<UnverifiedCleanupSummary> {
  const mode = enabled ? "enabled" : "dry-run";
  const candidates = await repository.findCandidates(MAX_PER_RUN);
  const summary: UnverifiedCleanupSummary = {
    mode,
    candidates: candidates.length,
    removed: 0,
    skipped: 0,
    failed: 0,
  };

  if (candidates.length === 0) {
    logger.info(
      { ...summary, minAgeDays: UNVERIFIED_MIN_AGE_DAYS },
      "Unverified-signup cleanup: nothing to do",
    );
    return summary;
  }

  // Domain only, never the address: these are, by definition, addresses nobody has
  // proved they own, and a log line is not a place to keep a copy of one.
  const listed = candidates.map((c) => ({
    companyId: c.company_id,
    createdAt: c.created_at,
    emailDomain: c.email_domain,
  }));

  if (!enabled) {
    logger.warn(
      { ...summary, minAgeDays: UNVERIFIED_MIN_AGE_DAYS, candidates: listed },
      "Unverified-signup cleanup DRY RUN — these signups would be removed. " +
        "Set UNVERIFIED_CLEANUP_ENABLED=true to arm it.",
    );
    return { ...summary, candidates: candidates.length };
  }

  for (const candidate of candidates) {
    try {
      // Own transaction per company: one failure must not roll back the others or
      // stop the rest of the run.
      const removed = await repository.removeCandidate(candidate.company_id);
      if (removed) {
        summary.removed++;
        logger.info(
          {
            companyId: removed.companyId,
            createdAt: removed.createdAt,
            emailDomain: removed.emailDomain,
            paymentsDeleted: removed.paymentsDeleted,
            subscriptionsDeleted: removed.subscriptionsDeleted,
          },
          "Unverified signup removed",
        );
      } else {
        summary.skipped++;
      }
    } catch (err) {
      summary.failed++;
      logger.error(
        { err, companyId: candidate.company_id },
        "Failed to remove unverified signup — skipping, will retry tomorrow",
      );
    }
  }

  logger.warn(summary, "Unverified-signup cleanup completed");
  return summary;
}

export function startUnverifiedCleanupCron(): void {
  if (task) return;
  task = cron.schedule(
    SCHEDULE,
    async () => {
      if (running) return;
      running = true;
      try {
        await cleanupUnverifiedSignups();
      } catch (err) {
        logger.error({ err }, "Unverified-signup cleanup run failed");
      } finally {
        running = false;
      }
    },
    { timezone: "UTC" },
  );

  const mode = config.UNVERIFIED_CLEANUP_ENABLED ? "enabled" : "dry-run";
  logger.info(
    { schedule: SCHEDULE, mode, minAgeDays: UNVERIFIED_MIN_AGE_DAYS },
    mode === "enabled"
      ? "Unverified-signup cleanup is ARMED — never-verified signups will be deleted"
      : "Unverified-signup cleanup started in DRY-RUN mode — candidates are only logged",
  );
}

export function stopUnverifiedCleanupCron(): void {
  task?.stop();
  task = null;
}
