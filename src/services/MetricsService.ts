import { AppDataSource } from "data-source";
import { toVisitorStats, type VisitorStats } from "@/utils/visitorStats";

/** Today in UTC as a Postgres date, computed by the database so app clocks never matter. */
const TODAY_UTC = `(now() AT TIME ZONE 'UTC')::date`;

export class MetricsService {
  /** One atomic upsert: concurrent visits on the same day never lose a count. */
  async recordVisit(): Promise<void> {
    await AppDataSource.query(
      `INSERT INTO "site_visits" ("day", "count")
       VALUES (${TODAY_UTC}, 1)
       ON CONFLICT ("day") DO UPDATE SET "count" = "site_visits"."count" + 1`,
    );
  }

  /**
   * Rolling windows ending today, inclusive: last7Days is today plus the six days before
   * it. One scan of a table that grows by a single row a day.
   */
  async getVisitorStats(): Promise<VisitorStats> {
    const rows = (await AppDataSource.query(
      `SELECT COALESCE(SUM("count") FILTER (WHERE "day" = ${TODAY_UTC}), 0) AS "today",
              COALESCE(SUM("count") FILTER (WHERE "day" > ${TODAY_UTC} - 7), 0) AS "last7Days",
              COALESCE(SUM("count") FILTER (WHERE "day" > ${TODAY_UTC} - 30), 0) AS "last30Days",
              COALESCE(SUM("count"), 0) AS "total"
         FROM "site_visits"`,
    )) as Record<string, unknown>[];
    return toVisitorStats(rows[0]);
  }
}
