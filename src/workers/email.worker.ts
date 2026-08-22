import { Worker, type Job } from "bullmq";
import { fromAddress, getMailer } from "@/config/mailer";
import { redisConfig } from "@/config/redis.config";
import { EMAIL_QUEUE_NAME, type EmailJobData } from "@/queues/email.queue";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { renderPasswordResetEmail } from "@/templates/passwordReset.template";
import { renderEmailVerificationEmail } from "@/templates/emailVerification.template";
import { renderSubscriptionNoticeEmail } from "@/templates/subscriptionNotice.template";
import { logger } from "@/utils/logger";
import { hasExhaustedRetries } from "@/workers/retry";

let worker: Worker<EmailJobData> | null = null;

async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const data = job.data;
  const mailer = getMailer();

  if (data.type === "passwordReset") {
    const rendered = renderPasswordResetEmail({
      resetUrl: data.resetUrl,
      expiresInMinutes: data.expiresInMinutes,
    });
    await mailer.sendMail({
      from: fromAddress(),
      to: data.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    logger.info({ jobId: job.id, type: data.type, to: data.to }, "Email sent");
    return;
  }

  if (data.type === "emailVerification") {
    const rendered = renderEmailVerificationEmail({
      verifyUrl: data.verifyUrl,
      expiresInMinutes: data.expiresInMinutes,
      trialDurationDays: data.trialDurationDays,
    });
    await mailer.sendMail({
      from: fromAddress(),
      to: data.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    logger.info({ jobId: job.id, type: data.type, to: data.to }, "Email sent");
    return;
  }

  if (data.type === "subscriptionNotice") {
    const rendered = renderSubscriptionNoticeEmail({
      kind: data.kind,
      companyName: data.companyName,
      deadline: new Date(data.deadline),
      billingUrl: data.billingUrl,
      exportUrl: data.exportUrl,
    });
    await mailer.sendMail({
      from: fromAddress(),
      to: data.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    logger.info({ jobId: job.id, type: data.type, kind: data.kind, to: data.to }, "Email sent");
    return;
  }

  if (data.type === "generic") {
    await mailer.sendMail({
      from: fromAddress(),
      to: data.to,
      subject: data.subject,
      html: data.html,
      ...(data.text ? { text: data.text } : {}),
    });
    logger.info({ jobId: job.id, type: data.type, to: data.to }, "Email sent");
    return;
  }

  throw new Error(`Unknown email job type: ${(data as { type: string }).type}`);
}

/**
 * Hand an expiry notice back to the cron after delivery has finally failed.
 *
 * The cron claims a notice by stamping `<kind>_notice_for` with the deadline, then
 * enqueues. It releases that claim if the *enqueue* throws — but an enqueue that
 * succeeds and a delivery that fails hours later looked identical to success. The
 * marker stayed set, the claim query skips any company whose marker already equals its
 * deadline, and the notice was silently gone forever.
 *
 * That is not hypothetical: an SMTP outage swallowed a real customer's trial-ended
 * email, and nothing would ever have sent it.
 *
 * The BullMQ job must be removed too. Its id is deterministic — kind, company and
 * deadline — and `queue.add` treats a matching id as a duplicate and drops it, so a
 * re-enqueue would silently do nothing while the dead job still existed.
 */
async function releaseNoticeClaim(job: Job<EmailJobData>): Promise<void> {
  const data = job.data;
  if (data?.type !== "subscriptionNotice" || !data.companyId) return;

  try {
    await new CompanyRepository().releaseExpiryNotice(data.kind, data.companyId);
    await job.remove();
    logger.warn(
      { jobId: job.id, kind: data.kind, companyId: data.companyId, to: data.to },
      "Notice delivery failed for good; claim released so the cron will retry it",
    );
  } catch (err) {
    // Leaving the claim set is the bad outcome, so say so loudly rather than swallow.
    logger.error(
      { err, jobId: job.id, kind: data.kind, companyId: data.companyId },
      "Could not release the expiry-notice claim — this notice will not be retried",
    );
  }
}

export function startEmailWorker(): Worker<EmailJobData> {
  if (worker) return worker;
  worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: redisConfig,
    concurrency: 5,
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, type: job?.data?.type, attempts: job?.attemptsMade, err },
      "Email job failed",
    );
    if (job && hasExhaustedRetries(job)) void releaseNoticeClaim(job);
  });

  worker.on("error", (err) => {
    logger.error({ err }, "Email worker error");
  });

  logger.info("Email worker started");
  return worker;
}

export async function stopEmailWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Email worker stopped");
  }
}
