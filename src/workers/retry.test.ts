import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "bullmq";
import { hasExhaustedRetries } from "@/workers/retry";

/** Only the two fields the check reads. */
const job = (attemptsMade: number, attempts?: number) =>
  ({ attemptsMade, opts: attempts === undefined ? {} : { attempts } }) as Pick<
    Job,
    "attemptsMade" | "opts"
  >;

describe("hasExhaustedRetries", () => {
  it("is false while retries remain", () => {
    // Releasing here would hand the notice back while an attempt is still pending,
    // and the customer would get the same email twice.
    for (const made of [1, 2, 3, 4]) {
      assert.equal(hasExhaustedRetries(job(made, 5)), false, `attempt ${made} of 5`);
    }
  });

  it("is true on the final attempt", () => {
    // The production config is 5 attempts, which is what swallowed the lost notice.
    assert.equal(hasExhaustedRetries(job(5, 5)), true);
  });

  it("is true if the count somehow overshoots", () => {
    assert.equal(hasExhaustedRetries(job(6, 5)), true);
  });

  it("treats a job with no retry policy as one-and-done", () => {
    // BullMQ defaults to a single attempt when `attempts` is unset; assuming more
    // would leave the claim stuck exactly as before.
    assert.equal(hasExhaustedRetries(job(1)), true);
    assert.equal(hasExhaustedRetries(job(0)), false);
  });
});
