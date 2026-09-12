import { emailQueue } from "@/queues/email.queue";
import { buildBulkEmailJob } from "@/queues/bulkEmailJob";
import { renderBulkAnnouncementEmail } from "@/templates/bulkAnnouncement.template";
import { config } from "@/config/index";
import { SettingsService } from "@/services/SettingsService";
import { logger } from "@/utils/logger";
import type { ExpiryNoticeKind } from "@/repositories/CompanyRepository";
import type { RefundAccessChange } from "@/templates/refundProcessed.template";
import { emailJobIds } from "@/utils/billingEmails";

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
      buildBulkEmailJob({
        to: input.to,
        rendered,
        ...(input.attachment ? { attachment: input.attachment } : {}),
      }),
      { jobId: `bulk-${encodeSegment(input.to)}-${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to }, "Bulk email enqueued");
  }

  /**
   * The invite that follows an admin creating a company on someone's behalf.
   *
   * Throws rather than swallowing: unlike a password reset, the recipient cannot ask
   * for this again — they do not know the account exists. A silent failure would leave
   * a company nobody can ever log into.
   */
  async enqueueAccountInvite(input: {
    to: string;
    setPasswordToken: string;
    companyName: string;
    expiresInHours: number;
    freeUntil: Date | null;
  }): Promise<void> {
    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    const job = await emailQueue.add("accountInvite", {
      type: "accountInvite",
      to: input.to,
      setPasswordUrl: `${base}/reset-password?token=${encodeURIComponent(input.setPasswordToken)}`,
      companyName: input.companyName,
      expiresInHours: input.expiresInHours,
      freeUntil: input.freeUntil ? input.freeUntil.toISOString() : null,
    });
    logger.info({ jobId: job.id, to: input.to }, "Account invite enqueued");
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

  /**
   * Sends an email the caller has already rendered, through the worker's existing
   * `generic` path, so no new job type or worker branch is needed. Used by the
   * login-email-change messages (templates/emailChange.template.ts).
   *
   * Throws on failure; the caller decides whether that should fail the request.
   */
  async enqueueRenderedEmail(input: {
    to: string;
    rendered: { subject: string; html: string; text?: string };
    /** Job id prefix, e.g. "emailchg". No colons (see enqueuePasswordReset). */
    tag: string;
  }): Promise<void> {
    const job = await emailQueue.add(
      "generic",
      {
        type: "generic",
        to: input.to,
        subject: input.rendered.subject,
        html: input.rendered.html,
        ...(input.rendered.text ? { text: input.rendered.text } : {}),
      },
      { jobId: `${encodeSegment(input.tag)}-${encodeSegment(input.to)}-${Date.now()}` },
    );
    logger.info({ jobId: job.id, to: input.to, tag: input.tag }, "Rendered email enqueued");
  }

  // ── Emails that report a committed change: QR code, receipt, failed renewal, refund ──
  //
  // Called only through NotificationService, after the caller's transaction commits.
  // Each job id is deterministic (utils/billingEmails.ts), so BullMQ drops a second add
  // for the same payment + email type. Completed jobs are kept for 30 days rather than
  // the queue's 24h/1000 default, so that dedupe window outlasts any PayPal retry
  // schedule. Log lines carry ids, never the recipient.

  async enqueueQrCodeEmail(input: {
    to: string;
    companyId: string;
    companyName: string;
    qrUrl: string;
  }): Promise<void> {
    const job = await emailQueue.add(
      "qrCode",
      {
        type: "qrCode",
        to: input.to,
        companyId: input.companyId,
        companyName: input.companyName,
        qrUrl: input.qrUrl,
        qrPageUrl: `${frontendBase()}/company/qr-code`,
      },
      { jobId: emailJobIds.qrCode(input.companyId), removeOnComplete: KEEP_FOR_DEDUPE },
    );
    logger.info({ jobId: job.id, companyId: input.companyId }, "QR code email enqueued");
  }

  async enqueuePaymentReceipt(input: {
    to: string;
    paymentId: string;
    companyName: string;
  }): Promise<void> {
    const job = await emailQueue.add(
      "paymentReceipt",
      {
        type: "paymentReceipt",
        to: input.to,
        paymentId: input.paymentId,
        companyName: input.companyName,
        billingUrl: `${frontendBase()}/company/billing`,
      },
      { jobId: emailJobIds.receipt(input.paymentId), removeOnComplete: KEEP_FOR_DEDUPE },
    );
    logger.info({ jobId: job.id, paymentId: input.paymentId }, "Payment receipt enqueued");
  }

  async enqueuePaymentFailed(input: {
    to: string;
    subscriptionId: string;
    companyName: string;
    accessUntil: Date | null;
  }): Promise<void> {
    const job = await emailQueue.add(
      "paymentFailed",
      {
        type: "paymentFailed",
        to: input.to,
        companyName: input.companyName,
        accessUntil: input.accessUntil ? input.accessUntil.toISOString() : null,
        billingUrl: `${frontendBase()}/company/billing`,
      },
      {
        jobId: emailJobIds.renewalFailed(input.subscriptionId, input.accessUntil),
        removeOnComplete: KEEP_FOR_DEDUPE,
      },
    );
    logger.info(
      { jobId: job.id, subscriptionId: input.subscriptionId },
      "Renewal-failed email enqueued",
    );
  }

  async enqueueRefundProcessed(input: {
    to: string;
    paymentId: string;
    extent: "full" | "partial";
    reversalId: string | null;
    companyName: string;
    amount: string | null;
    currency: string;
    description: string;
    invoiceNumber: string | null;
    access: RefundAccessChange;
  }): Promise<void> {
    const job = await emailQueue.add(
      "refundProcessed",
      {
        type: "refundProcessed",
        to: input.to,
        paymentId: input.paymentId,
        companyName: input.companyName,
        extent: input.extent,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        invoiceNumber: input.invoiceNumber,
        access: input.access,
        billingUrl: `${frontendBase()}/company/billing`,
      },
      {
        jobId: emailJobIds.refund(input.paymentId, input.extent, input.reversalId),
        removeOnComplete: KEEP_FOR_DEDUPE,
      },
    );
    logger.info(
      { jobId: job.id, paymentId: input.paymentId, extent: input.extent },
      "Refund email enqueued",
    );
  }
}

/** See the note above enqueueQrCodeEmail. */
const KEEP_FOR_DEDUPE = { age: 30 * 24 * 60 * 60 };

function frontendBase(): string {
  return config.FRONTEND_BASE_URL.replace(/\/$/, "");
}
