/**
 * Pure parts of the admin system-status check: types, redaction and classification.
 *
 * Kept apart from SystemStatusService so they can be unit-tested without importing the
 * email queue, whose module opens a Redis connection on load.
 */

export type ServiceKey = "database" | "redis" | "smtp" | "paypal" | "email_queue";
export type ServiceHealth = "ok" | "degraded" | "down";

export interface ServiceStatus {
  key: ServiceKey;
  name: string;
  status: ServiceHealth;
  latencyMs: number | null;
  detail: string;
  meta?: Record<string, unknown>;
}

export interface SystemStatus {
  checkedAt: string;
  services: ServiceStatus[];
}

/** How far back a failed email job still counts as "sends are failing". */
export const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Waiting + delayed jobs at or above this is a backlog worth flagging. */
export const QUEUE_BACKLOG_DEGRADED = 200;
const DETAIL_MAX = 300;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Removes email addresses and any known secret from text that will be shown in the UI.
 *
 * Failed-job reasons quote recipients ("550 <someone@x.com> mailbox unavailable"), and
 * an SMTP server can echo the login back. Neither belongs on a dashboard. Secrets are
 * removed first so a login that is itself an email address is caught either way.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    // Short values would redact ordinary words; real secrets are never this short.
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  out = out.replace(EMAIL_RE, "[email]");
  out = out.replaceAll(/\s+/g, " ").trim();
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX - 1)}…` : out;
}

/**
 * The most useful one-line explanation of a nodemailer failure.
 *
 * Prefers the server's own words (`response`, e.g. "535 5.7.8 Authentication failed" or
 * a suspension notice), because that is what tells the admin what to fix. Falls back to
 * the error code plus message for network failures that never got a response.
 */
export function smtpErrorDetail(err: unknown, secrets: readonly string[] = []): string {
  if (!err || typeof err !== "object") {
    return redact(String(err ?? "Unknown SMTP error"), secrets);
  }
  const e = err as {
    response?: unknown;
    responseCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const response = typeof e.response === "string" ? e.response.trim() : "";
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message.trim() : "";

  let detail: string;
  if (response) {
    const rc = typeof e.responseCode === "number" ? String(e.responseCode) : "";
    detail = rc && !response.startsWith(rc) ? `${rc} ${response}` : response;
  } else if (code && message && !message.includes(code)) {
    detail = `${code}: ${message}`;
  } else {
    detail = message || code || "Unknown SMTP error";
  }
  return redact(detail, secrets);
}

export interface QueueSnapshot {
  counts: { waiting: number; active: number; delayed: number; failed: number; completed: number };
  recentFailures: number;
  lastFailure: { reason: string; at: string } | null;
}

export function classifyQueue(q: QueueSnapshot): { status: ServiceHealth; detail: string } {
  const backlog = q.counts.waiting + q.counts.delayed;
  if (q.recentFailures > 0) {
    return {
      status: "degraded",
      detail: `${q.recentFailures} email job(s) failed in the last 24h${
        q.lastFailure ? `. Latest: ${q.lastFailure.reason}` : ""
      }`,
    };
  }
  if (backlog >= QUEUE_BACKLOG_DEGRADED) {
    return { status: "degraded", detail: `${backlog} emails are waiting to be sent` };
  }
  return { status: "ok", detail: backlog > 0 ? `${backlog} email(s) queued` : "Queue is empty" };
}

/**
 * SMTP verify() only proves we can log in. A suspended mailbox can still accept the
 * login while every send is rejected, so a verify that passes is downgraded when the
 * queue shows sends failing recently.
 */
export function classifySmtp(
  verify: { ok: true } | { ok: false; detail: string },
  queue: QueueSnapshot | null,
): { status: ServiceHealth; detail: string } {
  if (!verify.ok) return { status: "down", detail: verify.detail };
  if (queue && queue.recentFailures > 0) {
    return {
      status: "degraded",
      detail: `Login works, but ${queue.recentFailures} send(s) failed in the last 24h${
        queue.lastFailure ? `: ${queue.lastFailure.reason}` : ""
      }`,
    };
  }
  return { status: "ok", detail: "SMTP server accepted our login" };
}

export function classifyPaypal(
  token: { ok: true } | { ok: false; detail: string },
  mode: string,
  production: boolean,
): { status: ServiceHealth; detail: string } {
  if (!token.ok) return { status: "down", detail: token.detail };
  if (production && mode !== "live") {
    return {
      status: "degraded",
      detail: "PayPal is in sandbox mode: real payments are not being taken",
    };
  }
  return { status: "ok", detail: `Credentials accepted (${mode})` };
}
