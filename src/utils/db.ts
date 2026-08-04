/**
 * Unwraps the rows from a raw `UPDATE|INSERT|DELETE ... RETURNING` run through
 * TypeORM's `query()`.
 *
 * The postgres driver returns `[rows, rowCount]` for those statements — always, even
 * with a RETURNING clause — while a plain SELECT returns the rows directly. Two
 * different shapes from one method, and TypeScript types `query()` as `any`, so
 * getting it wrong is silent:
 *
 *   const rows = await manager.query(`UPDATE ... RETURNING a, b`);
 *   rows[0].a   // undefined — rows[0] is the array, not the first row
 *
 * That exact mistake shipped in `extendSubscription` and wrote NULL into
 * `payments.subscription_starts_at`/`ends_at`, losing the record of which period each
 * payment bought — with no error anywhere, because the columns are nullable.
 *
 * Use this for every raw RETURNING query rather than indexing the result by hand.
 */
export function returningRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  // [rows, rowCount] — the shape for UPDATE/INSERT/DELETE.
  const [rows] = result as [unknown, unknown];
  if (Array.isArray(rows)) return rows as T[];
  // A bare rows array (SELECT, or a driver that does not wrap).
  return result as T[];
}

/** Affected-row count from the same wrapped result. */
export function affectedRows(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const count = (result as unknown[])[1];
  return typeof count === "number" ? count : 0;
}
