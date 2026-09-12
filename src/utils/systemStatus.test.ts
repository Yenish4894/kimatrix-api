import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QUEUE_BACKLOG_DEGRADED,
  classifyPaypal,
  classifyQueue,
  classifySmtp,
  redact,
  smtpErrorDetail,
  type QueueSnapshot,
} from "@/utils/systemStatus";

const queue = (over: Partial<QueueSnapshot> = {}): QueueSnapshot => ({
  counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 10 },
  recentFailures: 0,
  lastFailure: null,
  ...over,
});

describe("redact", () => {
  it("removes email addresses", () => {
    assert.equal(
      redact("550 5.1.1 <jane.doe+x@example.co.za>: Recipient address rejected"),
      "550 5.1.1 <[email]>: Recipient address rejected",
    );
  });

  it("removes known secrets but ignores trivially short ones", () => {
    assert.equal(
      redact("auth failed for hunter22", ["hunter22", "ab"]),
      "auth failed for [redacted]",
    );
  });

  it("caps length", () => {
    assert.ok(redact("x".repeat(1000)).length <= 300);
  });
});

describe("smtpErrorDetail", () => {
  it("prefers the server response", () => {
    const err = Object.assign(new Error("Invalid login: 535 Authentication failed"), {
      code: "EAUTH",
      responseCode: 535,
      response: "535 5.7.8 Error: authentication failed",
    });
    assert.equal(smtpErrorDetail(err), "535 5.7.8 Error: authentication failed");
  });

  it("surfaces a suspension notice verbatim", () => {
    const err = { responseCode: 554, response: "Your account has been suspended" };
    assert.equal(smtpErrorDetail(err), "554 Your account has been suspended");
  });

  it("falls back to code and message for network errors", () => {
    const err = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
    assert.equal(smtpErrorDetail(err), "ETIMEDOUT: Connection timeout");
  });

  it("never leaks the login", () => {
    const err = { response: "535 authentication failed for info@kimates.com with s3cretPass" };
    const out = smtpErrorDetail(err, ["s3cretPass", "info@kimates.com"]);
    assert.doesNotMatch(out, /s3cretPass|info@kimates\.com/);
  });
});

describe("classifyQueue", () => {
  it("is ok when idle", () => {
    assert.equal(classifyQueue(queue()).status, "ok");
  });

  it("is degraded on recent failures and quotes the latest reason", () => {
    const r = classifyQueue(
      queue({
        recentFailures: 2,
        lastFailure: { reason: "535 auth", at: new Date().toISOString() },
      }),
    );
    assert.equal(r.status, "degraded");
    assert.match(r.detail, /535 auth/);
  });

  it("is degraded on a large backlog", () => {
    const r = classifyQueue(
      queue({
        counts: { waiting: QUEUE_BACKLOG_DEGRADED, active: 0, delayed: 0, failed: 0, completed: 0 },
      }),
    );
    assert.equal(r.status, "degraded");
  });
});

describe("classifySmtp", () => {
  it("is down when verify fails", () => {
    assert.deepEqual(classifySmtp({ ok: false, detail: "535 x" }, null), {
      status: "down",
      detail: "535 x",
    });
  });

  it("is degraded when login works but sends fail", () => {
    assert.equal(classifySmtp({ ok: true }, queue({ recentFailures: 1 })).status, "degraded");
  });

  it("is ok when login works and nothing failed", () => {
    assert.equal(classifySmtp({ ok: true }, queue()).status, "ok");
    assert.equal(classifySmtp({ ok: true }, null).status, "ok");
  });
});

describe("classifyPaypal", () => {
  it("flags sandbox in production", () => {
    const r = classifyPaypal({ ok: true }, "sandbox", true);
    assert.equal(r.status, "degraded");
    assert.match(r.detail, /real payments are not being taken/);
  });

  it("accepts sandbox outside production and live in production", () => {
    assert.equal(classifyPaypal({ ok: true }, "sandbox", false).status, "ok");
    assert.equal(classifyPaypal({ ok: true }, "live", true).status, "ok");
  });

  it("is down when the token request fails", () => {
    assert.equal(classifyPaypal({ ok: false, detail: "401" }, "live", true).status, "down");
  });
});
