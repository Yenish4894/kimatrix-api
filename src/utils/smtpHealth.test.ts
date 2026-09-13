import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifySmtpFailure,
  classifySmtpHealth,
  failureOutcome,
  lastErrorText,
  parseOutcome,
  successOutcome,
  type SmtpHealthRecord,
  type SmtpSendOutcome,
} from "@/utils/smtpHealth";

/** The exact reply Hostinger gave when it switched off outbound sending. */
const hostingerDisabled = Object.assign(
  new Error("Message failed: 554 5.7.1 Outbound sending is disabled"),
  {
    code: "EMESSAGE",
    responseCode: 554,
    response: "554 5.7.1 Outbound sending is disabled",
  },
);

const record = (over: Partial<SmtpHealthRecord> = {}): SmtpHealthRecord => ({
  last: null,
  lastSuccessAt: null,
  lastFailure: null,
  ...over,
});

const failed = (err: unknown, source: "job" | "canary" = "job"): SmtpSendOutcome =>
  failureOutcome(err, source);

describe("classifySmtpFailure", () => {
  it("treats Hostinger's outbound-disabled 554 as hard", () => {
    assert.equal(classifySmtpFailure(hostingerDisabled).kind, "hard");
  });

  it("treats an auth failure as hard", () => {
    const err = Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });
    assert.equal(classifySmtpFailure(err).kind, "hard");
  });

  it("treats a suspension notice as hard even without a reply code", () => {
    assert.equal(classifySmtpFailure(new Error("Your account has been suspended")).kind, "hard");
  });

  it("treats an unknown recipient as a recipient problem, not an SMTP one", () => {
    const err = {
      code: "EENVELOPE",
      responseCode: 550,
      response: "550 5.1.1 <x@y.z>: User unknown",
    };
    assert.equal(classifySmtpFailure(err).kind, "recipient");
  });

  it("treats 4xx and network errors as transient", () => {
    assert.equal(
      classifySmtpFailure({ responseCode: 421, response: "421 try later" }).kind,
      "transient",
    );
    assert.equal(
      classifySmtpFailure(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" })).kind,
      "transient",
    );
    assert.equal(classifySmtpFailure(new Error("something odd")).kind, "transient");
  });

  it("reads the reply code out of the response text when responseCode is missing", () => {
    const r = classifySmtpFailure({ response: "552 5.3.4 Message size exceeds limit" });
    assert.deepEqual([r.kind, r.responseCode], ["hard", 552]);
  });
});

describe("classifySmtpHealth", () => {
  const verifyOk = { ok: true } as const;

  it("is down when the last send failed hard, even though verify passes", () => {
    const last = failed(hostingerDisabled, "canary");
    const r = classifySmtpHealth({
      configured: true,
      verify: verifyOk,
      record: record({ last, lastFailure: last }),
      recentQueueFailures: 0,
    });
    assert.equal(r.status, "down");
    assert.match(r.detail, /Outbound sending is disabled/);
  });

  it("is degraded when the last send failed transiently", () => {
    const last = failed({ responseCode: 451, response: "451 temporary local problem" });
    const r = classifySmtpHealth({
      configured: true,
      verify: verifyOk,
      record: record({ last, lastFailure: last }),
      recentQueueFailures: 0,
    });
    assert.equal(r.status, "degraded");
  });

  it("is up after a recovery: an old failure does not outweigh a newer success", () => {
    const lastFailure = failed(hostingerDisabled);
    const r = classifySmtpHealth({
      configured: true,
      verify: verifyOk,
      record: record({ last: successOutcome("job"), lastSuccessAt: "x", lastFailure }),
      recentQueueFailures: 3,
    });
    assert.equal(r.status, "up");
  });

  it("is up when the last send was only refused for one recipient", () => {
    const last = failed({
      code: "EENVELOPE",
      responseCode: 550,
      response: "550 5.1.1 no such user",
    });
    const r = classifySmtpHealth({
      configured: true,
      verify: verifyOk,
      record: record({ last, lastFailure: last }),
      recentQueueFailures: 1,
    });
    assert.equal(r.status, "up");
  });

  it("is down when verify fails", () => {
    const r = classifySmtpHealth({
      configured: true,
      verify: { ok: false, detail: "535 auth" },
      record: record({ last: successOutcome("job") }),
      recentQueueFailures: 0,
    });
    assert.deepEqual(r, { status: "down", detail: "535 auth" });
  });

  it("falls back to the queue before any send has been recorded", () => {
    const base = { configured: true, verify: verifyOk, record: record() };
    assert.equal(classifySmtpHealth({ ...base, recentQueueFailures: 2 }).status, "degraded");
    assert.equal(classifySmtpHealth({ ...base, recentQueueFailures: 0 }).status, "up");
    assert.equal(classifySmtpHealth({ ...base, recentQueueFailures: null }).status, "up");
  });

  it("is down when SMTP is not configured", () => {
    const r = classifySmtpHealth({
      configured: false,
      verify: verifyOk,
      record: record(),
      recentQueueFailures: null,
    });
    assert.equal(r.status, "down");
  });
});

describe("outcome records", () => {
  it("round-trip through JSON", () => {
    const o = failed(hostingerDisabled, "canary");
    assert.deepEqual(parseOutcome(JSON.stringify(o)), o);
  });

  it("treat malformed or missing data as no record", () => {
    assert.equal(parseOutcome(null), null);
    assert.equal(parseOutcome("not json"), null);
    assert.equal(parseOutcome(JSON.stringify({ ok: "yes" })), null);
  });

  it("never carry the recipient or the login into the dashboard text", () => {
    const o = failureOutcome(
      { responseCode: 535, response: "535 auth failed for info@kimates.com / hunter22pw" },
      "job",
      ["hunter22pw", "info@kimates.com"],
    );
    const text = lastErrorText(record({ lastFailure: o })) ?? "";
    assert.doesNotMatch(text, /hunter22pw|info@kimates\.com/);
    assert.equal(lastErrorText(record()), null);
  });
});
