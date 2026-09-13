import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runExclusive, runningCrons, waitForRunningCrons } from "@/cron/runTracker";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("runExclusive", () => {
  it("skips a tick while the previous run of the same job is still going", async () => {
    const gate = deferred();
    let calls = 0;
    const first = runExclusive("t1", async () => {
      calls++;
      await gate.promise;
    });
    assert.equal(await runExclusive("t1", async () => void calls++), false);
    gate.resolve();
    assert.equal(await first, true);
    assert.equal(calls, 1);
    assert.deepEqual(runningCrons(), []);
  });

  it("swallows a failing run and frees the slot for the next tick", async () => {
    assert.equal(
      await runExclusive("t2", async () => {
        throw new Error("boom");
      }),
      true,
    );
    assert.equal(await runExclusive("t2", async () => undefined), true);
  });
});

describe("waitForRunningCrons", () => {
  it("resolves at once when nothing is running", async () => {
    assert.deepEqual(await waitForRunningCrons(10), []);
  });

  it("waits for an in-flight run to finish", async () => {
    const gate = deferred();
    const run = runExclusive("t3", () => gate.promise);
    setTimeout(() => gate.resolve(), 20);
    assert.deepEqual(await waitForRunningCrons(1_000), []);
    await run;
  });

  it("gives up after the timeout and names what is still running", async () => {
    const gate = deferred();
    const run = runExclusive("t4", () => gate.promise);
    assert.deepEqual(await waitForRunningCrons(20), ["t4"]);
    gate.resolve();
    await run;
  });
});
