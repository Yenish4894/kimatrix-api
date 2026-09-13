import cron, { type ScheduledTask } from "node-cron";
import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { fromAddress, sendMail, smtpSecrets } from "@/config/mailer";
import { runExclusive } from "@/cron/runTracker";
import { recordSmtpOutcome } from "@/services/SmtpHealthStore";
import { failureOutcome, successOutcome, type SmtpSendOutcome } from "@/utils/smtpHealth";
import { withTimeout } from "@/utils/withTimeout";
import { logger } from "@/utils/logger";

/**
 * Hourly SMTP canary: a short test email from our own sender to our own mailbox.
 *
 * Why: in August Hostinger switched off outbound sending for the mailbox ("554 5.7.1
 * Outbound sending is disabled"). Login still worked, so verify() said healthy, and on
 * a quiet afternoon there were no real emails to fail — nobody knew for hours. A send
 * every hour means the admin status turns red within the hour even when no customer
 * happens to trigger an email.
 *
 * The recipient is ALWAYS config.SMTP_USER — the authenticated mailbox itself. Never an
 * external address: a canary that bounces off a third party is exactly the kind of
 * failed delivery that gets a mailbox suspended in the first place.
 *
 * :17 past the hour keeps it off :00 (everything fires) and :05 (subscription cron).
 * Feature-flagged by SMTP_CANARY_ENABLED (on by default in production only).
 */
const SCHEDULE = "17 * * * *";

/** Distinct from every other cron's key. */
const ADVISORY_LOCK_KEY = 4_820_119;

/** Past this we stop waiting and record a timeout; Hostinger normally answers in ~1s. */
const SEND_TIMEOUT_MS = 30_000;

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let task: ScheduledTask | null = null;

/**
 * Sends one canary. Returns the outcome, or null when skipped (not configured, or
 * another instance holds the lock).
 */
export async function sendSmtpCanary(now = new Date()): Promise<SmtpSendOutcome | null> {
  const to = config.SMTP_USER;
  if (!config.SMTP_HOST || !SIMPLE_EMAIL.test(to)) {
    logger.warn("SMTP canary skipped — SMTP_HOST or a mailbox-style SMTP_USER is not configured");
    return null;
  }

  // Session-level lock on a pinned connection, as in the purge crons: lock and unlock
  // through the pool can land on different connections and leak the lock.
  const lockRunner = AppDataSource.createQueryRunner();
  await lockRunner.connect();
  try {
    const [{ locked }] = (await lockRunner.query(`SELECT pg_try_advisory_lock($1) AS locked`, [
      ADVISORY_LOCK_KEY,
    ])) as [{ locked: boolean }];
    if (!locked) {
      logger.debug("SMTP canary skipped — another instance holds the lock");
      return null;
    }
    try {
      return await sendOnce(to, now);
    } finally {
      await lockRunner.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await lockRunner.release();
  }
}

async function sendOnce(to: string, now: Date): Promise<SmtpSendOutcome> {
  try {
    // sendMail records the outcome itself (source "canary").
    await withTimeout(
      sendMail(
        {
          from: fromAddress(),
          to,
          subject: `KIMates SMTP canary ${now.toISOString()}`,
          text:
            "Automated hourly check that outbound email works. Safe to delete.\n" +
            "If these stop arriving, check the admin System status page.",
          headers: { "X-KIMates-Canary": "1" },
        },
        "canary",
      ),
      SEND_TIMEOUT_MS,
    );
    logger.info("SMTP canary accepted by the server");
    return successOutcome("canary", now);
  } catch (err) {
    const outcome = failureOutcome(err, "canary", smtpSecrets(), now);
    // A timeout is ours, not nodemailer's, so sendMail never recorded it. If the send
    // does complete later, its own record overwrites this one — later is truer.
    if ((err as { code?: unknown })?.code === "ETIMEDOUT") await recordSmtpOutcome(outcome);
    logger.error(
      { kind: outcome.kind, responseCode: outcome.responseCode, detail: outcome.message },
      outcome.kind === "hard"
        ? "SMTP canary REFUSED — outbound email is not working"
        : "SMTP canary failed",
    );
    return outcome;
  }
}

export function startSmtpCanaryCron(): void {
  if (task) return;
  if (!config.SMTP_CANARY_ENABLED) {
    logger.info("SMTP canary is disabled (SMTP_CANARY_ENABLED is not true)");
    return;
  }
  task = cron.schedule(
    SCHEDULE,
    async () => {
      await runExclusive("smtpCanary", () => sendSmtpCanary());
    },
    { timezone: "UTC" },
  );
  logger.info({ schedule: SCHEDULE }, "SMTP canary cron started");
}

export function stopSmtpCanaryCron(): void {
  task?.stop();
  task = null;
}
