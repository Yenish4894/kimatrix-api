import type { EmailJobData } from "@/queues/email.queue";

/**
 * Builds the queue payload for one bulk-announcement recipient.
 *
 * Pulled out of `EmailService` so it can be tested without importing the queue module,
 * which constructs a BullMQ `Queue` at import time and opens a Redis connection the
 * test runner would then hang on. Same reason `workers/retry.ts` exists.
 *
 * It is a small function guarding a fault that was invisible in review: the caller
 * accepted an `attachment` argument and simply never copied it into the payload. The
 * file was uploaded, stored, logged and recorded in the sent history, and the worker
 * knew how to attach it — the message just went out without it. An optional argument
 * that is accepted and unused is not a type error, so nothing anywhere complained.
 */
export function buildBulkEmailJob(input: {
  to: string;
  rendered: { subject: string; html: string; text?: string };
  attachment?: { path: string; filename: string };
}): Extract<EmailJobData, { type: "generic" }> {
  return {
    type: "generic",
    to: input.to,
    subject: input.rendered.subject,
    html: input.rendered.html,
    ...(input.rendered.text ? { text: input.rendered.text } : {}),
    // The path, never the bytes — see the note on EmailJobData.
    ...(input.attachment ? { attachment: input.attachment } : {}),
  };
}
