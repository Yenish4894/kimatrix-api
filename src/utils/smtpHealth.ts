/**
 * Pure parts of the SMTP send-health record: what a send outcome looks like, how a
 * nodemailer failure is classified, and how the admin status row is derived from it.
 *
 * Why this exists: Hostinger suspended outbound sending ("554 5.7.1 Outbound sending is
 * disabled") while the login still worked. `transporter.verify()` only proves the
 * login, so the dashboard kept showing SMTP as healthy for hours while every email
 * bounced. The truth is in the sends themselves, so every real send (and an hourly
 * canary) records its outcome and the status row is decided from the most recent one.
 *
 * No imports with side effects, so this is unit-testable without Redis or a mailer.
 */

import { redact, smtpErrorDetail } from "@/utils/systemStatus";

/**
 * - `hard`: the server refused to send for us at all — auth failure, a suspended or
 *   disabled account, any other 5xx that is not about one recipient. Nothing will go
 *   out until a human fixes it.
 * - `transient`: 4xx, timeouts, dropped connections. Retries may well succeed.
 * - `recipient`: the server accepted us as the sender but refused one address
 *   (550 5.1.1 user unknown). Proves sending works; says nothing bad about SMTP.
 */
export type SmtpFailureKind = "hard" | "transient" | "recipient";

export type SmtpSendSource = "job" | "canary";

export interface SmtpSendOutcome {
  ok: boolean;
  /** ISO timestamp. */
  at: string;
  source: SmtpSendSource;
  /** SMTP reply code (e.g. 554) when the server answered; null for network errors. */
  responseCode: number | null;
  /** nodemailer's error code (EAUTH, EENVELOPE, ETIMEDOUT…); null on success. */
  code: string | null;
  /** Redacted one-line reason; null on success. */
  message: string | null;
  /** Null on success. */
  kind: SmtpFailureKind | null;
}

export type SmtpHealthStatus = "up" | "degraded" | "down";

/** What the Redis record holds. Each part is independently optional (fresh install, expired key). */
export interface SmtpHealthRecord {
  last: SmtpSendOutcome | null;
  lastSuccessAt: string | null;
  lastFailure: SmtpSendOutcome | null;
}

const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNECTION",
  "ESOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "EDNS",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETLS",
  "EPROTOCOL",
]);

/** An account-level refusal, whatever reply code it came with. */
const ACCOUNT_BLOCKED_RE =
  /sending is disabled|outbound.*disabled|suspended|account.*(disabled|blocked|locked)|authentication (failed|unsuccessful)|invalid login|too many (login|auth)/i;

/** A refusal about one address, not about us. Enhanced status 5.1.x is "bad destination". */
const RECIPIENT_RE =
  /\b5\.1\.\d\b|user unknown|no such user|mailbox (unavailable|not found|does not exist)|recipient address rejected|does not exist|invalid recipient/i;

function numericResponseCode(err: { responseCode?: unknown; response?: unknown }): number | null {
  if (typeof err.responseCode === "number" && Number.isFinite(err.responseCode)) {
    return err.responseCode;
  }
  const lead = typeof err.response === "string" ? /^\s*(\d{3})\b/.exec(err.response) : null;
  return lead ? Number(lead[1]) : null;
}

export function classifySmtpFailure(err: unknown): {
  kind: SmtpFailureKind;
  responseCode: number | null;
  code: string | null;
} {
  const e = (err && typeof err === "object" ? err : {}) as {
    responseCode?: unknown;
    response?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const responseCode = numericResponseCode(e);
  const code = typeof e.code === "string" ? e.code : null;
  const text = [e.response, e.message].filter((v) => typeof v === "string").join(" ");

  // Checked before the reply code: Hostinger's suspension arrives as a 554 5.7.1, and a
  // bare "5xx means hard" rule would get it right only by accident.
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534 || responseCode === 530) {
    return { kind: "hard", responseCode, code };
  }
  if (ACCOUNT_BLOCKED_RE.test(text)) return { kind: "hard", responseCode, code };

  if (responseCode !== null && responseCode >= 500) {
    // EENVELOPE with a 5xx is nodemailer saying "every recipient was refused at RCPT".
    // The server got that far, so it accepted MAIL FROM: sending works.
    if (RECIPIENT_RE.test(text) || (code === "EENVELOPE" && !ACCOUNT_BLOCKED_RE.test(text))) {
      return { kind: "recipient", responseCode, code };
    }
    return { kind: "hard", responseCode, code };
  }
  if (responseCode !== null && responseCode >= 400) {
    return { kind: "transient", responseCode, code };
  }
  if (code && TRANSIENT_CODES.has(code)) return { kind: "transient", responseCode, code };

  // No reply code and no known network code: we could not tell. Treated as transient
  // so an unknown blip reads as "degraded" rather than claiming the account is dead.
  return { kind: "transient", responseCode, code };
}

export function successOutcome(source: SmtpSendSource, now = new Date()): SmtpSendOutcome {
  return {
    ok: true,
    at: now.toISOString(),
    source,
    responseCode: null,
    code: null,
    message: null,
    kind: null,
  };
}

export function failureOutcome(
  err: unknown,
  source: SmtpSendSource,
  secrets: readonly string[] = [],
  now = new Date(),
): SmtpSendOutcome {
  const { kind, responseCode, code } = classifySmtpFailure(err);
  return {
    ok: false,
    at: now.toISOString(),
    source,
    responseCode,
    code,
    message: smtpErrorDetail(err, secrets),
    kind,
  };
}

/**
 * The SMTP row of the admin system status.
 *
 * Precedence, first match wins:
 *   1. not configured                          → down
 *   2. most recent send failed `hard`          → down   (verify cannot override this)
 *   3. verify() failed                         → down
 *   4. most recent send failed `transient`     → degraded
 *   5. nothing recorded yet, queue has failures → degraded (the pre-record heuristic)
 *   6. otherwise                               → up
 *
 * A `recipient` failure counts as healthy: the server accepted us as the sender.
 */
export function classifySmtpHealth(input: {
  configured: boolean;
  verify: { ok: true } | { ok: false; detail: string };
  record: SmtpHealthRecord;
  /** Failed email jobs in the last 24h, when the queue could be read. */
  recentQueueFailures: number | null;
}): { status: SmtpHealthStatus; detail: string } {
  const { configured, verify, record } = input;
  if (!configured) return { status: "down", detail: "SMTP is not configured" };

  const last = record.last;
  if (last && !last.ok && last.kind === "hard") {
    return {
      status: "down",
      detail: `The last ${last.source === "canary" ? "test email" : "email"} was refused: ${
        last.message ?? "unknown error"
      }`,
    };
  }
  if (!verify.ok) return { status: "down", detail: verify.detail };
  if (last && !last.ok && last.kind === "transient") {
    return {
      status: "degraded",
      detail: `Login works, but the last send failed temporarily: ${last.message ?? "unknown error"}`,
    };
  }
  if (!last && (input.recentQueueFailures ?? 0) > 0) {
    return {
      status: "degraded",
      detail: `Login works, but ${input.recentQueueFailures} send(s) failed in the last 24h`,
    };
  }
  if (last?.ok) return { status: "up", detail: "Login works and the last email was accepted" };
  return { status: "up", detail: "SMTP server accepted our login" };
}

/** The error text shown on the dashboard: from the latest failure, already redacted. */
export function lastErrorText(record: SmtpHealthRecord): string | null {
  const f = record.lastFailure;
  if (!f) return null;
  return redact(f.message ?? "Unknown SMTP error");
}

/** Parses a stored outcome defensively; anything malformed reads as "no record". */
export function parseOutcome(raw: string | null | undefined): SmtpSendOutcome | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SmtpSendOutcome>;
    if (typeof v.ok !== "boolean" || typeof v.at !== "string") return null;
    return {
      ok: v.ok,
      at: v.at,
      source: v.source === "canary" ? "canary" : "job",
      responseCode: typeof v.responseCode === "number" ? v.responseCode : null,
      code: typeof v.code === "string" ? v.code : null,
      message: typeof v.message === "string" ? v.message : null,
      kind: v.kind === "hard" || v.kind === "transient" || v.kind === "recipient" ? v.kind : null,
    };
  } catch {
    return null;
  }
}

/**
 * True when the most recent real send was refused outright (a `hard` failure: account
 * suspended, auth refused). Until a human fixes that, nothing queued will be delivered —
 * so a caller that just queued an email (the admin's "Add company" invite) can say so
 * instead of implying it went out. Transient and per-recipient failures do not count.
 */
export function isSmtpDeliveryDown(record: SmtpHealthRecord): boolean {
  const last = record.last;
  return last !== null && !last.ok && last.kind === "hard";
}
