import { config, isProduction } from "@/config/index";
import { DatabaseHealthRepository } from "@/repositories/DatabaseHealthRepository";
import { fromAddress, getMailer } from "@/config/mailer";
import { getRedisClient } from "@/config/redis.client";
import { emailQueue } from "@/queues/email.queue";
import { PaypalService } from "@/services/PaypalService";
import { readSmtpHealth } from "@/services/SmtpHealthStore";
import { logger } from "@/utils/logger";
import { classifySmtpHealth, lastErrorText, type SmtpHealthRecord } from "@/utils/smtpHealth";
import {
  RECENT_FAILURE_WINDOW_MS,
  classifyPaypal,
  classifyQueue,
  redact,
  smtpErrorDetail,
  type QueueSnapshot,
  type ServiceKey,
  type ServiceStatus,
  type SmtpServiceStatus,
  type SystemStatus,
} from "@/utils/systemStatus";
import { withTimeout } from "@/utils/withTimeout";

/**
 * Third-party health for the admin dashboard.
 *
 * Exists because Hostinger suspended the SMTP mailbox and nobody knew: every email
 * job failed quietly in the background while the app itself looked healthy. Each
 * check asks the dependency directly rather than trusting our own state.
 *
 * Every check has its own timeout and its own catch, so one hung dependency (a Redis
 * that is reconnecting, an SMTP server that never answers) can only mark ITS row as
 * down. It can never fail or stall the endpoint.
 */

/** Dashboard loads within this window share one result, so they never hammer SMTP or PayPal. */
const CACHE_TTL_MS = 60_000;
const DB_TIMEOUT_MS = 5_000;
const REDIS_TIMEOUT_MS = 3_000;
const SMTP_TIMEOUT_MS = 10_000;
const PAYPAL_TIMEOUT_MS = 10_000;
const QUEUE_TIMEOUT_MS = 5_000;
/** How many of the newest failed jobs are inspected. Bounded so the check stays cheap. */
const FAILED_SAMPLE = 50;

type CheckResult = Omit<ServiceStatus, "key" | "name">;

const EMPTY_SMTP_RECORD: SmtpHealthRecord = { last: null, lastSuccessAt: null, lastFailure: null };

function secrets(): string[] {
  return [config.SMTP_PASS, config.SMTP_USER, config.PAYPAL_CLIENT_SECRET, config.REDIS_PASSWORD];
}

function errorText(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err), secrets());
}

let cached: { at: number; value: SystemStatus } | null = null;
let inFlight: Promise<SystemStatus> | null = null;

export class SystemStatusService {
  constructor(private readonly databaseHealth = new DatabaseHealthRepository()) {}

  async getStatus(refresh = false): Promise<SystemStatus> {
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    // Concurrent loads (two admins, or a double render) share one run instead of
    // opening two SMTP sessions.
    inFlight ??= this.runChecks()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  private async runChecks(): Promise<SystemStatus> {
    // Read once and shared: the queue row reports it, and the SMTP row falls back on it
    // before any send outcome has been recorded.
    const queue = this.readQueue();
    const queueOrNull = queue.catch(() => null);

    const services = await Promise.all([
      this.guard("database", "Database", () => this.checkDatabase()),
      this.guard("redis", "Redis", () => this.checkRedis()),
      this.checkSmtp(queueOrNull),
      this.guard("paypal", "PayPal", () => this.checkPaypal()),
      this.guard("email_queue", "Email queue", () => this.checkQueue(queue)),
    ]);
    return { checkedAt: new Date().toISOString(), services };
  }

  /** The last line of defence: whatever a check throws becomes a "down" row, never a 500. */
  private async guard(
    key: ServiceKey,
    name: string,
    fn: () => Promise<CheckResult>,
  ): Promise<ServiceStatus> {
    try {
      return { key, name, ...(await fn()) };
    } catch (err) {
      const detail = errorText(err);
      logger.warn({ key, detail }, "System status check failed");
      return { key, name, status: "down", latencyMs: null, detail };
    }
  }

  private async timed<T>(fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
    const start = performance.now();
    const value = await fn();
    return { value, latencyMs: Math.round(performance.now() - start) };
  }

  private async checkDatabase(): Promise<CheckResult> {
    const { latencyMs } = await this.timed(() =>
      withTimeout(this.databaseHealth.ping(), DB_TIMEOUT_MS),
    );
    return { status: "ok", latencyMs, detail: "Responding" };
  }

  private async checkRedis(): Promise<CheckResult> {
    // The same client the rate limiter uses, so this reports the connection the app
    // actually depends on rather than a fresh one that might behave differently.
    const { value, latencyMs } = await this.timed(() =>
      withTimeout(getRedisClient().ping(), REDIS_TIMEOUT_MS),
    );
    if (value !== "PONG") {
      return {
        status: "down",
        latencyMs,
        detail: `Unexpected reply: ${String(value).slice(0, 40)}`,
      };
    }
    return { status: "ok", latencyMs, detail: "PONG" };
  }

  /**
   * verify() still runs — it catches wrong credentials and an unreachable host — but it
   * only proves the LOGIN. Hostinger's "Outbound sending is disabled" leaves the login
   * working, so the recorded outcome of the latest real send (or hourly canary) is what
   * decides "down"; a passing verify can never mask it. See utils/smtpHealth.ts.
   *
   * Never throws: its own catch turns anything unexpected into a "down" row.
   */
  private async checkSmtp(queue: Promise<QueueSnapshot | null>): Promise<SmtpServiceStatus> {
    const base = { key: "smtp" as const, name: "Email (SMTP)" };
    const meta = { host: config.SMTP_HOST, port: config.SMTP_PORT, from: fromAddress() };
    try {
      // A Redis outage must not hide the verify result, so a failed read is "no record".
      const recordPromise = withTimeout(readSmtpHealth(), REDIS_TIMEOUT_MS).catch(
        (err: unknown) => {
          logger.warn({ detail: errorText(err) }, "Could not read the SMTP send record");
          return EMPTY_SMTP_RECORD;
        },
      );

      const configured = Boolean(config.SMTP_HOST);
      let verify: { ok: true } | { ok: false; detail: string } = { ok: true };
      let latencyMs: number | null = null;
      if (configured) {
        const start = performance.now();
        try {
          await withTimeout(getMailer().verify(), SMTP_TIMEOUT_MS);
          latencyMs = Math.round(performance.now() - start);
        } catch (err) {
          verify = { ok: false, detail: smtpErrorDetail(err, secrets()) };
        }
      }

      const [record, q] = await Promise.all([recordPromise, queue]);
      const { status, detail } = classifySmtpHealth({
        configured,
        verify,
        record,
        recentQueueFailures: q ? q.recentFailures : null,
      });
      return {
        ...base,
        status,
        latencyMs,
        detail,
        meta: { ...meta, lastSendSource: record.last?.source ?? null },
        lastSuccessAt: record.lastSuccessAt,
        lastFailureAt: record.lastFailure?.at ?? null,
        lastError: lastErrorText(record),
      };
    } catch (err) {
      const detail = errorText(err);
      logger.warn({ key: "smtp", detail }, "System status check failed");
      return {
        ...base,
        status: "down",
        latencyMs: null,
        detail,
        meta,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
      };
    }
  }

  private async checkPaypal(): Promise<CheckResult> {
    const meta = { mode: config.PAYPAL_MODE };
    if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
      return {
        status: "down",
        latencyMs: null,
        detail: "PayPal credentials are not configured",
        meta,
      };
    }
    // A fresh instance has an empty token cache, so this always asks PayPal instead of
    // reporting a token cached hours before the credentials were revoked.
    const { value, latencyMs } = await this.timed(() =>
      withTimeout(new PaypalService().verifyCredentials(), PAYPAL_TIMEOUT_MS),
    );
    const token = value.ok
      ? ({ ok: true } as const)
      : ({ ok: false, detail: redact(value.detail, secrets()) } as const);
    const { status, detail } = classifyPaypal(token, config.PAYPAL_MODE, isProduction);
    return { status, latencyMs: value.ok ? latencyMs : null, detail, meta };
  }

  private readQueue(): Promise<QueueSnapshot> {
    const read = async (): Promise<QueueSnapshot> => {
      const c = await emailQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      );
      // Only exhausted jobs land in `failed` (retries sit in `delayed`), so anything
      // here is an email that was never delivered.
      const failed = await emailQueue.getFailed(0, FAILED_SAMPLE - 1);
      const since = Date.now() - RECENT_FAILURE_WINDOW_MS;
      const stamp = (j: { finishedOn?: number; timestamp: number }) => j.finishedOn ?? j.timestamp;
      const recent = failed.filter((j) => stamp(j) >= since);
      const latest = [...failed].sort((a, b) => stamp(b) - stamp(a))[0];
      return {
        counts: {
          waiting: c["waiting"] ?? 0,
          active: c["active"] ?? 0,
          delayed: c["delayed"] ?? 0,
          failed: c["failed"] ?? 0,
          completed: c["completed"] ?? 0,
        },
        recentFailures: recent.length,
        lastFailure: latest
          ? {
              reason: redact(latest.failedReason || "No reason recorded", secrets()),
              at: new Date(stamp(latest)).toISOString(),
            }
          : null,
      };
    };
    return withTimeout(read(), QUEUE_TIMEOUT_MS);
  }

  /** BullMQ lives in Redis, so a timeout here almost always means Redis is down. */
  private async checkQueue(queue: Promise<QueueSnapshot>): Promise<CheckResult> {
    const { value: q, latencyMs } = await this.timed(() => queue);
    const { status, detail } = classifyQueue(q);
    return {
      status,
      latencyMs,
      detail,
      meta: { ...q.counts, recentFailures: q.recentFailures, lastFailure: q.lastFailure },
    };
  }
}
