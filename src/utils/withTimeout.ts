/**
 * Rejects with an ETIMEDOUT-coded error if `promise` has not settled within `ms`.
 *
 * The underlying work is NOT cancelled — a promise cannot be — so use this only where
 * giving up on waiting is the point (a health check, a canary), never to "undo" a write.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`ETIMEDOUT: no answer within ${ms / 1000}s`), {
            code: "ETIMEDOUT",
          }),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
