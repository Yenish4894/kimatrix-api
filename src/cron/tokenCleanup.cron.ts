import cron, { type ScheduledTask } from "node-cron";
import { TokenRepository } from "@/repositories/TokenRepository";
import { logger } from "@/utils/logger";

const TOKEN_RETENTION_DAYS = 30;
const SCHEDULE = "0 3 * * *"; // 03:00 every day

let task: ScheduledTask | null = null;

export function startTokenCleanupCron(): void {
  if (task) return;
  const tokenRepository = new TokenRepository();
  task = cron.schedule(
    SCHEDULE,
    async () => {
      const cutoff = new Date(Date.now() - TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      try {
        const deleted = await tokenRepository.deleteTombstonedOlderThan(cutoff);
        logger.info({ deleted, cutoff }, "Token cleanup cron completed");
      } catch (err) {
        logger.error({ err }, "Token cleanup cron failed");
      }
    },
    { timezone: "UTC" },
  );
  logger.info(
    { schedule: SCHEDULE, retentionDays: TOKEN_RETENTION_DAYS },
    "Token cleanup cron started",
  );
}

export function stopTokenCleanupCron(): void {
  if (task) {
    task.stop();
    task = null;
    logger.info("Token cleanup cron stopped");
  }
}
