import { AppDataSource } from "data-source";

/** The SQL half of an export dataset. */
export interface ExportSql {
  /** SELECT list, aliased to the dataset's columns plus the two cursor fields. */
  select: string;
  from: string;
  /** The timestamp half of the keyset cursor. */
  cursorColumn: string;
}

export interface ExportCursor {
  ts: Date;
  id: string;
}

/**
 * The SQL for each export dataset. `ip_address`, `user_agent` and raw latitude/longitude
 * are deliberately absent — see ExportService.
 *
 * Interpolated into SQL, so every value here must stay a hard-coded literal.
 */
export const EXPORT_DATASET_SQL = {
  customers: {
    select: `c."mobile", c."full_name", c."vehicle_number", c."total_invoice_amount",
             c."submission_count", c."first_submission_at", c."last_submission_at",
             c."last_submission_at" AS _cursor_ts, c."id" AS _cursor_id`,
    from: `"customers" c WHERE c."company_id" = $1 AND c."deleted_at" IS NULL`,
    cursorColumn: `c."last_submission_at"`,
  },
  purchases: {
    select: `p."invoice_number", p."invoice_amount", cu."mobile",
             p."full_name_snapshot", p."vehicle_number_snapshot", p."submitted_at",
             p."submitted_at" AS _cursor_ts, p."id" AS _cursor_id`,
    from: `"purchases" p
             INNER JOIN "customers" cu ON cu."id" = p."customer_id"
           WHERE p."company_id" = $1 AND p."deleted_at" IS NULL AND p."voided_at" IS NULL`,
    cursorColumn: `p."submitted_at"`,
  },
} satisfies Record<string, ExportSql>;

export class ExportRepository {
  /**
   * One batch, newest first.
   *
   * The keyset predicate is a row-value comparison — `(ts, id) < ($2, $3)` — which
   * Postgres evaluates as a single tuple comparison. Comparing the columns separately
   * (`ts < $2 OR (ts = $2 AND id < $3)`) is the usual hand-written version and is easy
   * to get subtly wrong when timestamps tie, which they do: bulk submissions land in
   * the same millisecond and the naive form then either skips or repeats them.
   */
  async fetchBatch(
    spec: ExportSql,
    companyId: string,
    cursor: ExportCursor | null,
    batchSize: number,
  ): Promise<Record<string, unknown>[]> {
    const idColumn = spec.cursorColumn.replace(/"[^"]+"$/, '"id"');
    const keyset = cursor
      ? `AND (${spec.cursorColumn}, ${idColumn}) < ($2::timestamptz, $3::uuid)`
      : "";
    const params = cursor ? [companyId, cursor.ts, cursor.id] : [companyId];

    return (await AppDataSource.query(
      `SELECT ${spec.select}
         FROM ${spec.from}
         ${keyset}
        ORDER BY ${spec.cursorColumn} DESC, ${idColumn} DESC
        LIMIT ${batchSize}`,
      params,
    )) as Record<string, unknown>[];
  }
}
