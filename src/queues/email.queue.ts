import { Queue } from "bullmq";
import { redisConfig } from "@/config/redis.config";

export type EmailJobData =
  | {
      type: "passwordReset";
      to: string;
      resetUrl: string;
      expiresInMinutes: number;
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
