import { fetchWithTimeout } from "@/utils/fetchWithTimeout";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 5_000;

/**
 * `unreachable` is kept apart from `rejected` so the log says which one happened: a
 * run of `unreachable` is a Cloudflare or network incident, a run of `rejected` is a
 * bot. The customer sees the same message either way.
 */
export type TurnstileVerdict =
  | { ok: true }
  | { ok: false; reason: "rejected" | "unreachable"; errorCodes: string[] };

export type TurnstileFetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: TurnstileFetch = (url, init) =>
  fetchWithTimeout(url, init, TURNSTILE_TIMEOUT_MS);

/**
 * Server-side check of a Turnstile token. Never throws.
 *
 * The token alone proves nothing — a bot can post any string — so it must be redeemed
 * against Cloudflare with our secret. Tokens are single-use and expire after 300s,
 * which is why the frontend must reset the widget after ANY failed submit.
 */
export async function verifyTurnstileToken(
  token: string,
  remoteIp: string | undefined,
  secret: string,
  fetchImpl: TurnstileFetch = defaultFetch,
): Promise<TurnstileVerdict> {
  const body = new URLSearchParams({ secret, response: token });
  // Optional to Cloudflare, but it lets them spot a token solved on one machine and
  // replayed from another.
  if (remoteIp) body.set("remoteip", remoteIp);

  let payload: { success?: unknown; "error-codes"?: unknown };
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return { ok: false, reason: "unreachable", errorCodes: [`http_${res.status}`] };
    payload = (await res.json()) as typeof payload;
  } catch {
    // Timeout, DNS, TLS or a non-JSON body: we never got an answer.
    return { ok: false, reason: "unreachable", errorCodes: ["network"] };
  }

  const errorCodes = Array.isArray(payload["error-codes"])
    ? payload["error-codes"].filter((c): c is string => typeof c === "string")
    : [];
  if (payload.success === true) return { ok: true };
  // Cloudflare's own failure is not a verdict on the visitor.
  if (errorCodes.includes("internal-error"))
    return { ok: false, reason: "unreachable", errorCodes };
  return { ok: false, reason: "rejected", errorCodes };
}
