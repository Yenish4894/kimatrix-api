import { emailQueue } from "@/queues/email.queue";
import { config } from "@/config/index";
import { logger } from "@/utils/logger";

export interface SendPasswordResetInput {
  to: string;
  resetToken: string;
  expiresInMinutes?: number;
}

export interface SendEmailVerificationInput {
  to: string;
  verificationToken: string;
  expiresInMinutes?: number;
}

export class EmailService {
  async enqueuePasswordReset(input: SendPasswordResetInput): Promise<void> {
    const expiresInMinutes = input.expiresInMinutes ?? config.PASSWORD_RESET_TTL_MIN;
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(input.resetToken)}`;

    const job = await emailQueue.add(
      "passwordReset",
      {
        type: "passwordReset",
        to: input.to,
        resetUrl,
        expiresInMinutes,
      },
      { jobId: `pwreset:${input.to}:${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to }, "Password reset email enqueued");
  }

  async enqueueEmailVerification(input: SendEmailVerificationInput): Promise<void> {
    const expiresInMinutes = input.expiresInMinutes ?? config.EMAIL_VERIFICATION_TTL_MIN;
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    const verifyUrl = `${base}/verify-email?token=${encodeURIComponent(input.verificationToken)}`;

    const job = await emailQueue.add(
      "emailVerification",
      {
        type: "emailVerification",
        to: input.to,
        verifyUrl,
        expiresInMinutes,
        trialDurationDays: config.TRIAL_DURATION_DAYS,
      },
      { jobId: `verify:${input.to}:${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to }, "Email verification enqueued");
  }
}
