export interface VisitorStats {
  today: number;
  last7Days: number;
  last30Days: number;
  total: number;
}

/**
 * Normalises the aggregate row from `site_visits`.
 *
 * Postgres returns SUM over an integer column as bigint, which node-postgres hands back
 * as a string ("42"), and an empty table as null. Either would leak straight into the
 * JSON response and break a frontend doing arithmetic on it.
 */
export function toVisitorStats(row: Record<string, unknown> | undefined): VisitorStats {
  const n = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  };
  return {
    today: n(row?.["today"]),
    last7Days: n(row?.["last7Days"]),
    last30Days: n(row?.["last30Days"]),
    total: n(row?.["total"]),
  };
}
