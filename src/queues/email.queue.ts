import { Queue } from "bullmq";
import { redisConfig } from "@/config/redis.config";
import type { ExpiryNoticeKind } from "@/repositories/CompanyRepository";

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
      companyName: string;
      /** ISO string — BullMQ serialises job data to JSON, so a Date would arrive as one anyway. */
      deadline: string;
      billingUrl: string;
      exportUrl: string;
    }
  | {
      type: "generic";
      to: string;
      subject: string;
      html: string;
      text?: string;
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
