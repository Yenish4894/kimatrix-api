import "reflect-metadata";
import "dotenv/config";
import app from "@/app";
import { config, validateConfig } from "@/config/index";
import { initializeDatabase, closeDatabase } from "data-source";
import { getRedisClient, closeRedis } from "@/config/redis.client";
import { closeEmailQueue } from "@/queues/email.queue";
import { startEmailWorker, stopEmailWorker } from "@/workers/email.worker";
import { startTokenCleanupCron, stopTokenCleanupCron } from "@/cron/tokenCleanup.cron";
import { logger } from "@/utils/logger";

async function start(): Promise<void> {
  validateConfig();
  await initializeDatabase();
  getRedisClient();
  startEmailWorker();
  startTokenCleanupCron();

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "Server listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down gracefully");
    const forceTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close(() => logger.info("HTTP server closed"));
    stopTokenCleanupCron();
    await stopEmailWorker();
    await closeEmailQueue();
    await closeDatabase();
    await closeRedis();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
