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
import { startExpiredDataPurgeCron, stopExpiredDataPurgeCron } from "@/cron/expiredDataPurge.cron";
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

let shuttingDown = false;
/** Set once start() has wired the graceful shutdown; null during boot. */
let shutdownHook: ((signal: string, exitCode: number) => Promise<void>) | null = null;

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
  startExpiredDataPurgeCron();

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "Server listening");
  });

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    // SIGTERM followed by SIGINT, or a crash mid-shutdown, must not start a second
    // run that closes the pool twice.
    if (shuttingDown) return;
    shuttingDown = true;
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
    stopExpiredDataPurgeCron();
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
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  shutdownHook = shutdown;
}

// Both registered before start() so a failure during boot is caught too.
//
// A rejection is logged and the process kept up. Node's default would kill the whole
// server — every in-flight capture and scan — over one stray promise, which unlike a
// synchronous throw has not left shared state half-mutated. It is logged at error so
// it is seen, never swallowed.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

// After an uncaught exception the process state is unknown, so we never carry on.
// Drain what we can through the normal shutdown (bounded by its 10s force timer), then
// exit non-zero so pm2 restarts us. During boot there is nothing to drain yet.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — shutting down");
  if (!shutdownHook || shuttingDown) {
    process.exit(1);
  }
  shutdownHook("uncaughtException", 1).catch((shutdownErr: unknown) => {
    logger.error({ err: shutdownErr }, "Graceful shutdown after uncaught exception failed");
    process.exit(1);
  });
});

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
