/**
 * `fetch` with a hard deadline.
 *
 * Node's fetch has no timeout of its own: a peer that accepts the connection and then
 * never answers holds the request — and the customer waiting on it — open until the
 * socket dies, which can be minutes. Every outbound call we make sits on a user-facing
 * path (payment capture, signup verification), so each one needs a bound.
 *
 * On expiry the promise rejects with an AbortError, which callers treat as
 * "unreachable" rather than as an answer.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}
