import { promises as dnsPromises } from "node:dns";
import { disposableEmailBlocklistSet } from "disposable-email-domains-js";
import { ValidationError, type AppErrorDetail } from "@/middleware/errorHandler";
import { logger } from "@/utils/logger";

/**
 * Stops undeliverable addresses at the door.
 *
 * Why this exists: every signup mails a verification link at once, and bounces from
 * fake or mistyped addresses (test@gmail.com, tvb@gmail.com, isorathiya21@gmai.com) got
 * the Hostinger SMTP mailbox suspended twice. A suspended mailbox takes ALL mail down —
 * password resets, invoices, QR codes — for every customer, so one bad signup is an
 * outage, not a nuisance.
 *
 * Three checks, cheapest first, so the network is only touched when the address has
 * already passed the two in-memory ones:
 *   1. typo       — a known misspelling of a big consumer provider
 *   2. disposable — a throwaway-inbox domain
 *   3. DNS        — the domain cannot receive mail at all
 *
 * What it CANNOT catch: a well-formed address at a real provider whose mailbox does not
 * exist (test@gmail.com). Only an SMTP conversation can tell that, and probing Gmail's
 * servers from our IP would get us blocklisted faster than the bounces did.
 */

export type DeliverabilityReason = "typo" | "no_mail_server" | "disposable";

export type DeliverabilityResult =
  | { ok: true }
  | { ok: false; reason: DeliverabilityReason; message: string; suggestion?: string };

/** One resolver attempt, bounded. A DNS hiccup must cost a signup seconds, never minutes. */
export const DNS_TIMEOUT_MS = 3_000;
export const DNS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Bounds memory if someone feeds us a stream of random domains. */
const DNS_CACHE_MAX_ENTRIES = 5_000;

// ─── Typo check ─────────────────────────────────────────────────────────────────────

/**
 * Misspellings seen in the wild, including ones the edit-distance check below would
 * refuse to guess at (a changed TLD, or two errors at once). gmail.co.in / gmail.co.za
 * are here because Indian and South African users append their country TLD to a
 * provider that has none.
 */
const TYPO_MAP: Readonly<Record<string, string>> = {
  // gmail
  "gmai.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmil.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gmali.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gmaiil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmsil.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.comm": "gmail.com",
  "gmail.cmo": "gmail.com",
  "gmail.vom": "gmail.com",
  "gmail.xom": "gmail.com",
  "gmail.in": "gmail.com",
  "gmail.co.in": "gmail.com",
  "gmail.co.za": "gmail.com",
  "gmial.co": "gmail.com",
  // yahoo
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yhoo.com": "yahoo.com",
  "yahho.com": "yahoo.com",
  "yaoo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yahoo.cm": "yahoo.com",
  "yaho.co.in": "yahoo.co.in",
  "yahoo.co.inn": "yahoo.co.in",
  // outlook
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "outlool.com": "outlook.com",
  "outook.com": "outlook.com",
  "otlook.com": "outlook.com",
  "outlook.co": "outlook.com",
  "outlook.con": "outlook.com",
  // hotmail
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotamil.com": "hotmail.com",
  "hotmil.com": "hotmail.com",
  "hotmaill.com": "hotmail.com",
  "homail.com": "hotmail.com",
  "hotnail.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  // live
  "live.co": "live.com",
  "live.con": "live.com",
  "liv.com": "live.com",
  // icloud
  "iclod.com": "icloud.com",
  "icoud.com": "icloud.com",
  "iclould.com": "icloud.com",
  "icload.com": "icloud.com",
  "icloud.co": "icloud.com",
  "icloud.con": "icloud.com",
  // rediffmail (common with Indian users)
  "rediffmial.com": "rediffmail.com",
  "redifmail.com": "rediffmail.com",
  "rediffmai.com": "rediffmail.com",
  "rediffmal.com": "rediffmail.com",
  "rediffmail.co": "rediffmail.com",
  "rediffmail.con": "rediffmail.com",
};

/**
 * Targets for the edit-distance guess. live.com is deliberately absent: at 8 characters
 * its one-edit neighbourhood is full of real business domains (hive.com, five.com, …),
 * so live.com typos are handled by the explicit map only.
 */
const EDIT_DISTANCE_TARGETS = [
  "gmail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "rediffmail.com",
] as const;

/**
 * Real domains that sit one or two edits from a popular one. Without this list
 * ymail.com (Yahoo's own) would be "corrected" to gmail.com and a real customer turned
 * away. Also used to skip the DNS lookup for providers that obviously accept mail.
 */
const KNOWN_REAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.in",
  "yahoo.co.za",
  "yahoo.co.uk",
  "yahoo.ca",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "outlook.in",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.co.za",
  "hotmail.ca",
  "hotmail.fr",
  "live.com",
  "live.in",
  "live.co.uk",
  "live.co.za",
  "live.ca",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "cloud.com",
  "rediffmail.com",
  "rediff.com",
  "mail.com",
  "email.com",
  "gmx.com",
  "gmx.net",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "zoho.com",
  "zohomail.in",
  "mweb.co.za",
  "webmail.co.za",
  "vodamail.co.za",
  "telkomsa.net",
  "wahoo.com",
]);

/** Optimal-string-alignment distance: Levenshtein plus adjacent transposition (gmial). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i]![0] = i;
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

const tld = (domain: string): string => domain.slice(domain.lastIndexOf(".") + 1);

/** Returns the corrected domain, or null when the domain looks intentional. */
export function suggestDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  if (KNOWN_REAL_DOMAINS.has(d)) return null;
  const mapped = TYPO_MAP[d];
  if (mapped) return mapped;

  let best: { target: string; distance: number } | null = null;
  for (const target of EDIT_DISTANCE_TARGETS) {
    const distance = editDistance(d, target);
    if (!best || distance < best.distance) best = { target, distance };
  }
  if (!best) return null;
  if (best.distance === 1) return best.target;
  // Two edits only when the TLD already agrees and the name is long enough that two
  // slips are more likely than a real, different domain. live.ca and yahoo.ca are two
  // edits from their .com siblings and are genuine — the TLD rule keeps them safe.
  if (best.distance === 2 && d.length >= 8 && tld(d) === tld(best.target)) return best.target;
  return null;
}

/** Full corrected address, e.g. "isorathiya21@gmai.com" → "isorathiya21@gmail.com". */
export function suggestEmailCorrection(email: string): string | null {
  const parts = splitEmail(email);
  if (!parts) return null;
  const fixed = suggestDomain(parts.domain);
  return fixed ? `${parts.local}@${fixed}` : null;
}

// ─── Disposable check ───────────────────────────────────────────────────────────────

// Loaded once: the list is ~5k entries and a Set lookup per label is all we need.
const DISPOSABLE_DOMAINS = disposableEmailBlocklistSet();

/**
 * Matches the domain and every parent domain, so `x.mailinator.com` is caught by the
 * `mailinator.com` entry — throwaway services hand out wildcard subdomains precisely to
 * dodge exact-match lists. Stops before the bare TLD, which is never a list entry.
 */
export function isDisposableDomain(domain: string, list: ReadonlySet<string> = DISPOSABLE_DOMAINS) {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

// ─── DNS check ──────────────────────────────────────────────────────────────────────

export interface DnsResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

/**
 * Only these are ANSWERS ("this name does not exist" / "exists but has no such
 * record"). NXDOMAIN is not a code Node emits itself but some resolver shims do.
 * Everything else — ETIMEOUT, ESERVFAIL, ECONNREFUSED, EREFUSED — says our resolver had
 * a bad moment, and blocking a real business's signup on our infrastructure's problem
 * would be the wrong way round.
 */
const DEFINITIVE_NEGATIVE_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

export function classifyDnsError(err: unknown): "negative" | "transient" {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && DEFINITIVE_NEGATIVE_CODES.has(code) ? "negative" : "transient";
}

type Attempt<T> =
  | { kind: "ok"; value: T }
  | { kind: "negative" }
  | { kind: "transient"; code: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { kind: "ok", value: await fn() };
  } catch (err) {
    if (classifyDnsError(err) === "negative") return { kind: "negative" };
    const code = (err as { code?: unknown } | null)?.code;
    return { kind: "transient", code: typeof code === "string" ? code : "UNKNOWN" };
  }
}

export type MailHostVerdict =
  | { verdict: "has_mail" }
  | { verdict: "no_mail" }
  | { verdict: "unknown"; detail: string };

/**
 * MX first; if there is none, an A or AAAA record is an implicit MX (RFC 5321 §5.1),
 * so a small business whose domain only has a website record can still get mail.
 * A "null MX" (a single record pointing at ".", RFC 7505) is the domain saying outright
 * that it accepts no mail, and is treated as a definitive no.
 */
export async function lookupMailHost(
  domain: string,
  resolver: DnsResolver,
): Promise<MailHostVerdict> {
  const mx = await attempt(() => resolver.resolveMx(domain));
  if (mx.kind === "transient") return { verdict: "unknown", detail: `MX ${mx.code}` };
  if (mx.kind === "ok") {
    const usable = mx.value.filter((r) => r.exchange !== "" && r.exchange !== ".");
    if (usable.length > 0) return { verdict: "has_mail" };
    if (mx.value.length > 0) return { verdict: "no_mail" };
  }

  const [a4, a6] = await Promise.all([
    attempt(() => resolver.resolve4(domain)),
    attempt(() => resolver.resolve6(domain)),
  ]);
  if ((a4.kind === "ok" && a4.value.length > 0) || (a6.kind === "ok" && a6.value.length > 0)) {
    return { verdict: "has_mail" };
  }
  if (a4.kind === "transient") return { verdict: "unknown", detail: `A ${a4.code}` };
  if (a6.kind === "transient") return { verdict: "unknown", detail: `AAAA ${a6.code}` };
  return { verdict: "no_mail" };
}

const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Never keep the process alive (tests, graceful shutdown) just to time out a lookup.
    timer.unref();
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────────────

function splitEmail(email: string): { local: string; domain: string } | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return {
    local: trimmed.slice(0, at),
    // A trailing root dot ("gmail.com.") is legal DNS but not how people write domains.
    domain: trimmed
      .slice(at + 1)
      .toLowerCase()
      .replace(/\.$/, ""),
  };
}

export interface DeliverabilityCheckerOptions {
  resolver?: DnsResolver;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export type DeliverabilityChecker = (email: string) => Promise<DeliverabilityResult>;

/**
 * Factory so tests can inject a resolver and a clock; production uses the default
 * instance below. Each checker owns its own cache.
 */
export function createDeliverabilityChecker(
  options: DeliverabilityCheckerOptions = {},
): DeliverabilityChecker {
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DNS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  // One try: the overall race below is the real deadline, and retries inside c-ares
  // would only spend it.
  const resolver = options.resolver ?? new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });

  // Only definitive answers are cached. Caching an "unknown" would turn a two-second
  // resolver blip into ten minutes of unchecked signups — or, worse, a cached negative
  // from a blip would block a real domain for ten minutes.
  const cache = new Map<string, { verdict: "has_mail" | "no_mail"; expiresAt: number }>();

  async function mailVerdict(domain: string): Promise<MailHostVerdict> {
    const hit = cache.get(domain);
    if (hit && hit.expiresAt > now()) return { verdict: hit.verdict };
    if (hit) cache.delete(domain);

    const result = await withTimeout(lookupMailHost(domain, resolver), timeoutMs);
    if (result === TIMED_OUT) return { verdict: "unknown", detail: `timeout ${timeoutMs}ms` };

    if (result.verdict !== "unknown") {
      // Map iteration order is insertion order, so the first key is the oldest.
      if (cache.size >= DNS_CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(domain, { verdict: result.verdict, expiresAt: now() + cacheTtlMs });
    }
    return result;
  }

  return async (email: string): Promise<DeliverabilityResult> => {
    const parts = splitEmail(email);
    // Malformed input is Joi's job and has already been rejected by the time a service
    // calls this. Answering "ok" rather than inventing a second syntax error keeps
    // there being exactly one source of truth for what a valid address looks like.
    if (!parts) return { ok: true };

    const fixedDomain = suggestDomain(parts.domain);
    if (fixedDomain) {
      const suggestion = `${parts.local}@${fixedDomain}`;
      return { ok: false, reason: "typo", message: `Did you mean ${suggestion}?`, suggestion };
    }

    if (isDisposableDomain(parts.domain)) {
      return {
        ok: false,
        reason: "disposable",
        message:
          "Temporary or disposable email addresses can't be used. Please use a permanent email address.",
      };
    }

    // The big providers accept mail by definition; asking DNS is latency for nothing.
    if (KNOWN_REAL_DOMAINS.has(parts.domain)) return { ok: true };

    const mail = await mailVerdict(parts.domain);
    if (mail.verdict === "no_mail") {
      return {
        ok: false,
        reason: "no_mail_server",
        message: `The domain "${parts.domain}" can't receive email. Please check the address.`,
      };
    }
    if (mail.verdict === "unknown") {
      // Fail open, loudly. A DNS hiccup must never cost us a real signup; the
      // unverified-signup cleanup is the backstop for anything that slips through.
      logger.warn(
        { domain: parts.domain, detail: mail.detail },
        "Email DNS check inconclusive — allowing the address",
      );
    }
    return { ok: true };
  };
}

export const checkEmailDeliverable: DeliverabilityChecker = createDeliverabilityChecker();

export interface EmailFieldToCheck {
  /** The request-body field name, so the frontend can put the message under it. */
  field: string;
  value: string | null | undefined;
}

/**
 * Checks every address a request is about to store, and throws ONE 400 carrying a
 * field error per bad address — the same VALIDATION_ERROR shape Joi failures produce,
 * so the frontend's existing field mapping needs nothing new.
 *
 * Callers must run this before any DB write, token or email: the entire point is that
 * nothing is ever sent to an address that failed.
 */
export async function assertEmailsDeliverable(
  fields: EmailFieldToCheck[],
  check: DeliverabilityChecker = checkEmailDeliverable,
): Promise<void> {
  const present = fields.filter((f): f is { field: string; value: string } => !!f.value);
  const results = await Promise.all(present.map(async (f) => ({ f, r: await check(f.value) })));

  const details: AppErrorDetail[] = [];
  for (const { f, r } of results) {
    if (r.ok) continue;
    details.push({ field: f.field, message: r.message });
    // Domain only: the full address is personal data and adds nothing to the signal.
    logger.info(
      { field: f.field, reason: r.reason, domain: splitEmail(f.value)?.domain },
      "Email address rejected as undeliverable",
    );
  }

  if (details.length > 0) {
    throw ValidationError(
      details.length === 1 ? details[0]!.message : "Please check the highlighted email addresses.",
      details,
    );
  }
}
