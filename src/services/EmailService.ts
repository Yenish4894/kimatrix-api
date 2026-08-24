import { emailQueue } from "@/queues/email.queue";
import { renderBulkAnnouncementEmail } from "@/templates/bulkAnnouncement.template";
import { config } from "@/config/index";
import { SettingsService } from "@/services/SettingsService";
import { logger } from "@/utils/logger";
import type { ExpiryNoticeKind } from "@/repositories/CompanyRepository";

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

/** Strips anything that could collide with BullMQ's key separators. */
function encodeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

export interface SendSubscriptionNoticeInput {
  to: string;
  kind: ExpiryNoticeKind;
  companyId: string;
  companyName: string;
  deadline: Date;
}

export class EmailService {
  private settingsService = new SettingsService();

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
      // No colons anywhere in a jobId. BullMQ rejects one unless the id splits into
      // exactly three colon-separated parts, so `a:b:c` passes and `a:b:c:d` throws.
      // The previous `pwreset:${to}:${Date.now()}` only worked by accident — it
      // happened to be three parts — and one extra segment would have turned every
      // password-reset request into a 500.
      { jobId: `pwreset-${encodeSegment(input.to)}-${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to }, "Password reset email enqueued");
  }

  async enqueueEmailVerification(input: SendEmailVerificationInput): Promise<void> {
    const expiresInMinutes = input.expiresInMinutes ?? config.EMAIL_VERIFICATION_TTL_MIN;
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    const verifyUrl = `${base}/verify-email?token=${encodeURIComponent(input.verificationToken)}`;

    // Read the live, admin-editable trial length rather than the config fallback, so
    // the email never promises a different number of days from the one granted.
    const trialDurationDays = await this.settingsService.getTrialDurationDays();

    const job = await emailQueue.add(
      "emailVerification",
      {
        type: "emailVerification",
        to: input.to,
        verifyUrl,
        expiresInMinutes,
        trialDurationDays,
      },
      { jobId: `verify-${encodeSegment(input.to)}-${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to }, "Email verification enqueued");
  }

  /**
   * Throws on failure rather than swallowing it. The caller has already committed the
   * send-once marker, so it needs to know to put the notice back — otherwise a Redis
   * blip permanently consumes the customer's only warning email.
   */
  async enqueueBulkEmail(input: {
    to: string;
    subject: string;
    body: string;
    attachment?: { path: string; filename: string };
  }): Promise<void> {
    // Rendered through the same branded shell as every other email. This used to hand
    // the mailer bare <p> tags, so a platform-wide announcement arrived unstyled while
    // a password reset from the same system looked polished.
    const rendered = renderBulkAnnouncementEmail({ subject: input.subject, body: input.body });
    const job = await emailQueue.add(
      "generic",
      {
        type: "generic",
        to: input.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      },
      { jobId: `bulk-${encodeSegment(input.to)}-${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to }, "Bulk email enqueued");
  }

  async enqueueSubscriptionNotice(input: SendSubscriptionNoticeInput): Promise<void> {
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");

    const job = await emailQueue.add(
      "subscriptionNotice",
      {
        type: "subscriptionNotice",
        to: input.to,
        kind: input.kind,
        companyId: input.companyId,
        companyName: input.companyName,
        deadline: input.deadline.toISOString(),
        billingUrl: `${base}/company/billing`,
        exportUrl: `${base}/company/export`,
      },
      {
        // Deterministic, and keyed on the deadline as well as the kind: a second
        // attempt for the same deadline is a duplicate and BullMQ drops it, while a
        // genuinely new deadline (trial extended, subscription renewed then lapsed
        // again) produces a different id and does send. Belt and braces alongside the
        // database marker, which is the real guarantee.
        // Epoch millis rather than an ISO string: an ISO timestamp is full of colons.
        jobId: `notice-${input.kind}-${input.companyId}-${input.deadline.getTime()}`,
      },
    );
    logger.info(
      { jobId: job.id, kind: input.kind, companyId: input.companyId },
      "Subscription notice enqueued",
    );
  }
}
