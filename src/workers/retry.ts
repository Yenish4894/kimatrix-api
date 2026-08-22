import type { Job } from "bullmq";

/**
 * Has BullMQ finished retrying this job?
 *
 * Lives in its own module with no imports beyond a type, because the worker pulls in
 * the queue — which constructs a BullMQ `Queue` at module load and opens a Redis
 * connection. A test that imported the worker to reach this function would hang
 * forever instead of exiting.
 *
 * The off-by-one here decides between sending a customer the same email twice and
 * losing it entirely, and neither shows up until it happens to a real person.
 */
export function hasExhaustedRetries(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const allowed = job.opts?.attempts ?? 1;
  return (job.attemptsMade ?? 0) >= allowed;
}
