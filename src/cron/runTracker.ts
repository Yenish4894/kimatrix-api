import { logger } from "@/utils/logger";

/**
 * Keeps track of which cron jobs are running right now, so shutdown can wait for them.
 *
 * Before this, SIGTERM stopped the schedules and went straight on to closing the pool.
 * A purge or reconcile that was mid-loop had its connection pulled away and died
 * half-way; the per-company transactions kept that from corrupting anything, but the
 * run was lost and the logs read like a database failure. Waiting (bounded — see
 * server.ts) lets the in-flight company finish.
 *
 * Also replaces each cron's own `running` flag: a job that is still going when its
 * next tick fires is skipped, exactly as before.
 *
 * No imports beyond the logger, so it can be unit-tested without a database.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` unless a run with this name is already in flight. Errors are logged and
 * swallowed: a cron callback that rejects has nobody to report to.
 *
 * @returns false when the run was skipped because one was already going.
 */
export async function runExclusive(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  if (inFlight.has(name)) {
    logger.debug({ cron: name }, "Cron tick skipped — the previous run is still going");
    return false;
  }
  const run = (async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, cron: name }, "Cron run failed");
    }
  })();
  inFlight.set(name, run);
  try {
    await run;
  } finally {
    inFlight.delete(name);
  }
  return true;
}

export function runningCrons(): string[] {
  return [...inFlight.keys()];
}

/**
 * Resolves once every in-flight run has finished, or after `timeoutMs`, whichever comes
 * first. Returns the names still running at that point (empty on a clean drain).
 */
export async function waitForRunningCrons(timeoutMs: number): Promise<string[]> {
  if (inFlight.size === 0) return [];
  logger.info({ crons: runningCrons(), timeoutMs }, "Waiting for running cron jobs to finish");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const drained = Promise.allSettled([...inFlight.values()]).then(() => "drained" as const);
  const result = await Promise.race([drained, timedOut]);
  clearTimeout(timer);
  const left = result === "timeout" ? runningCrons() : [];
  if (left.length > 0) {
    logger.warn({ crons: left }, "Cron jobs still running at shutdown — they will be cut off");
  }
  return left;
}
