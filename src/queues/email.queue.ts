import { Queue } from "bullmq";
import { redisConfig } from "@/config/redis.config";
import type { ExpiryNoticeKind } from "@/repositories/CompanyRepository";
import type { RefundAccessChange } from "@/templates/refundProcessed.template";

export type EmailJobData =
  | {
      type: "passwordReset";
      to: string;
      resetUrl: string;
      expiresInMinutes: number;
    }
  | {
      type: "emailVerification";
      to: string;
      verifyUrl: string;
      expiresInMinutes: number;
      trialDurationDays: number;
    }
  | {
      type: "subscriptionNotice";
      to: string;
      kind: ExpiryNoticeKind;
      /** Needed to release the notice claim if delivery ultimately fails. */
      companyId: string;
      companyName: string;
      /** ISO string — BullMQ serialises job data to JSON, so a Date would arrive as one anyway. */
      deadline: string;
      billingUrl: string;
      exportUrl: string;
    }
  | {
      type: "accountInvite";
      to: string;
      /** A password-reset link. The token type is shared; only the wording differs. */
      setPasswordUrl: string;
      companyName: string;
      expiresInHours: number;
      /** ISO string, or null for a complimentary period with no end date. */
      freeUntil: string | null;
    }
  | {
      type: "qrCode";
      to: string;
      companyId: string;
      companyName: string;
      /** The public URL the code encodes. The PDF is built at send time, not stored here. */
      qrUrl: string;
      qrPageUrl: string;
    }
  | {
      type: "paymentReceipt";
      to: string;
      /** Everything else (amount, period, the invoice PDF) is read at send time. */
      paymentId: string;
      companyName: string;
      billingUrl: string;
    }
  | {
      type: "paymentFailed";
      to: string;
      companyName: string;
      /** ISO string, or null when the company has no paid end date on record. */
      accessUntil: string | null;
      billingUrl: string;
    }
  | {
      type: "refundProcessed";
      to: string;
      paymentId: string;
      companyName: string;
      extent: "full" | "partial";
      amount: string | null;
      currency: string;
      description: string;
      invoiceNumber: string | null;
      access: RefundAccessChange;
      billingUrl: string;
    }
  | {
      type: "generic";
      to: string;
      subject: string;
      html: string;
      text?: string;
      /**
       * A path on disk, never the file's bytes.
       *
       * A bulk send enqueues one job per recipient. Embedding a 10 MB attachment in
       * each would push a gigabyte through Redis for a hundred recipients, and Redis
       * keeps it in memory. The file is written once and every job points at it.
       */
      attachment?: { path: string; filename: string };
    };

export const EMAIL_QUEUE_NAME = "email";

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
  },
});

export async function closeEmailQueue(): Promise<void> {
  await emailQueue.close();
}
