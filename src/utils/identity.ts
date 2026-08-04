import crypto from "node:crypto";
import { config } from "@/config/index";
import type { TrialIdentifierType } from "@/entities/TrialIdentity";

/**
 * Canonicalisation + hashing for the trial identity registry.
 *
 * Pure and DB-free so the canonicalisation rules — the part most likely to be argued
 * about — can be unit-tested on their own.
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Collapses the addresses that reach the same inbox onto one key.
 *
 * Without this the registry is trivially defeated: `owner+1@gmail.com`,
 * `owner+2@gmail.com` and `o.w.n.e.r@gmail.com` are one mailbox but three distinct
 * strings, so one person farms unlimited free trials from a single account without
 * even needing a disposable-mail service.
 *
 * Sub-address (`+tag`) stripping is applied to every domain: the `+` convention is
 * near-universal and, where it is honoured, the tagged address is by definition the
 * same mailbox owner. Dot-stripping is applied ONLY to Gmail, because it is a Gmail
 * quirk — `a.b@fastmail.com` and `ab@fastmail.com` really are different people.
 */
export function canonicalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) local = local.replaceAll(".", "");

  return `${local}@${domain}`;
}

/**
 * Inputs are already E.164-validated at the Joi boundary, so this only has to strip
 * the punctuation people paste in (`+27 11 123-4567`).
 */
export function canonicalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function canonicalizeIdentifier(type: TrialIdentifierType, value: string): string {
  return type === "email" ? canonicalizeEmail(value) : canonicalizePhone(value);
}

/**
 * HMAC-SHA256 under the server pepper, over a type-prefixed canonical value.
 *
 * HMAC rather than a bare digest because the candidate space is small enough to
 * enumerate: every E.164 mobile in a country is ~10^8–10^9 values, which a bare
 * SHA-256 gives up in minutes. Without the pepper this table would effectively store
 * plaintext contact details for everyone who ever signed up.
 *
 * The type prefix keeps the email and phone namespaces from ever colliding, which is
 * what lets the unique index sit on `identifier_hash` alone.
 */
export function hashIdentifier(type: TrialIdentifierType, value: string): string {
  const canonical = canonicalizeIdentifier(type, value);
  return crypto
    .createHmac("sha256", config.TRIAL_IDENTITY_PEPPER)
    .update(`${type}:${canonical}`)
    .digest("hex");
}

/**
 * A masked form support can read back to a caller asking why they were refused.
 * Shows enough to be recognised by the person who owns it and not enough to be
 * useful to anyone else — and, unlike the raw value, it is safe to log.
 */
export function maskIdentifier(type: TrialIdentifierType, value: string): string {
  const canonical = canonicalizeIdentifier(type, value);

  if (type === "email") {
    const at = canonical.lastIndexOf("@");
    if (at <= 0) return "•".repeat(6);
    const local = canonical.slice(0, at);
    const domain = canonical.slice(at);
    const head = local.slice(0, 1);
    const tail = local.length > 2 ? local.slice(-1) : "";
    return `${head}${"•".repeat(Math.max(1, local.length - head.length - tail.length))}${tail}${domain}`.slice(
      0,
      64,
    );
  }

  // Keep the country prefix and the last four — the two parts a person recognises.
  const head = canonical.startsWith("+") ? canonical.slice(0, 3) : canonical.slice(0, 2);
  const tail = canonical.slice(-4);
  const middle = Math.max(1, canonical.length - head.length - tail.length);
  return `${head}${"•".repeat(middle)}${tail}`.slice(0, 64);
}
