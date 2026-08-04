import { Worker, type Job } from "bullmq";
import { fromAddress, getMailer } from "@/config/mailer";
import { redisConfig } from "@/config/redis.config";
import { EMAIL_QUEUE_NAME, type EmailJobData } from "@/queues/email.queue";
import { renderPasswordResetEmail } from "@/templates/passwordReset.template";
import { renderEmailVerificationEmail } from "@/templates/emailVerification.template";
import { renderSubscriptionNoticeEmail } from "@/templates/subscriptionNotice.template";
import { logger } from "@/utils/logger";

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
