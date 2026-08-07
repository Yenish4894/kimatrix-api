import "reflect-metadata";
import "dotenv/config";
import app from "@/app";
import { config, validateConfig, isProduction } from "@/config/index";
import { initializeDatabase, closeDatabase } from "data-source";
import { getRedisClient, closeRedis } from "@/config/redis.client";
import { closeEmailQueue } from "@/queues/email.queue";
import { startEmailWorker, stopEmailWorker } from "@/workers/email.worker";
import { startTokenCleanupCron, stopTokenCleanupCron } from "@/cron/tokenCleanup.cron";
import {
  startSubscriptionStatusCron,
  stopSubscriptionStatusCron,
} from "@/cron/subscriptionStatus.cron";
import { startAccountDeletionCron, stopAccountDeletionCron } from "@/cron/accountDeletion.cron";
import { logger } from "@/utils/logger";
import { getMailer } from "@/config/mailer";

async function checkSmtpConnection(): Promise<void> {
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    logger.warn("SMTP is not configured — email sending will not work");
    return;
  }
  try {
    await getMailer().verify();
    logger.info({ host: config.SMTP_HOST, port: config.SMTP_PORT }, "SMTP connection verified");
  } catch (err) {
    logger.warn(
      { err, host: config.SMTP_HOST, port: config.SMTP_PORT },
      "SMTP connection failed — email sending will not work until this is resolved",
    );
  }
}

function warnIfPaymentsMisconfigured(): void {
  if (!isProduction) return;
  const missing = (
    [
      ["PAYPAL_CLIENT_ID", config.PAYPAL_CLIENT_ID],
      ["PAYPAL_CLIENT_SECRET", config.PAYPAL_CLIENT_SECRET],
      ["PAYPAL_WEBHOOK_ID", config.PAYPAL_WEBHOOK_ID],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    logger.warn(
      { missing, paypalMode: config.PAYPAL_MODE },
      "PayPal is not fully configured — payment capture and/or webhook activation will not work until these are set",
    );
  } else if (config.PAYPAL_MODE !== "live") {
    logger.warn(
      { paypalMode: config.PAYPAL_MODE },
      "PAYPAL_MODE is not 'live' in production — payments will use the PayPal sandbox",
    );
  }
}

async function start(): Promise<void> {
  validateConfig();
  warnIfPaymentsMisconfigured();
  await initializeDatabase();
  await checkSmtpConnection();
  getRedisClient();
  startEmailWorker();
  startTokenCleanupCron();
  startSubscriptionStatusCron();
  startAccountDeletionCron();

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

    // Awaited. Previously this was fire-and-forget, so `closeDatabase()` ran while
    // requests were still executing — in-flight PayPal captures and QR submissions had
    // the pool pulled out from under them mid-transaction and lost their writes on every
    // deploy. server.close() stops accepting new connections immediately and resolves
    // only once the last in-flight response has been sent; the 10s force timer above
    // bounds it if a client holds a connection open.
    stopTokenCleanupCron();
    stopSubscriptionStatusCron();
    stopAccountDeletionCron();
    await new Promise<void>((resolve) => {
      server.close(() => {
        logger.info("HTTP server closed");
        resolve();
      });
    });
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
