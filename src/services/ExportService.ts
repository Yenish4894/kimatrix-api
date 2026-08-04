import type { Response } from "express";
import { AppDataSource } from "data-source";
import { csvRow, UTF8_BOM } from "@/utils/csv";
import { logger } from "@/utils/logger";

export const EXPORT_DATASETS = ["customers", "purchases"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export type ExportFormat = "csv" | "json";

/**
 * Rows per round trip. Large enough that a 36k-row export is ~36 queries rather than
 * thousands, small enough that no single batch is a meaningful amount of heap.
 */
const BATCH_SIZE = 1000;

interface DatasetSpec {
  /** Human column headers, in the order `columns` produces them. */
  headers: string[];
  /** Output aliases, in order. Also the JSON keys. */
  columns: string[];
  /** SELECT list, aliased to `columns` plus the two cursor fields. */
  select: string;
  from: string;
  /** The timestamp half of the keyset cursor. */
  cursorColumn: string;
}

/**
 * `ip_address` and `user_agent` are deliberately absent from both datasets.
 *
 * They are third-party personal data, collected from anonymous members of the public
 * for one narrow purpose — fraud prevention at submission time. Putting them in a file
 * the merchant downloads is further processing for a different purpose, which is a
 * POPIA problem, and the merchant has no use for them. The same reasoning keeps raw
 * latitude/longitude out: the customer consented to a business recording a purchase,
 * not to being handed a movement log.
 */
const DATASETS: Record<ExportDataset, DatasetSpec> = {
  customers: {
    headers: [
      "Mobile",
      "Full name",
      "Vehicle number",
      "Total spend",
      "Submissions",
      "First submission",
      "Last submission",
    ],
    columns: [
      "mobile",
      "full_name",
      "vehicle_number",
      "total_invoice_amount",
      "submission_count",
      "first_submission_at",
      "last_submission_at",
    ],
    select: `c."mobile", c."full_name", c."vehicle_number", c."total_invoice_amount",
             c."submission_count", c."first_submission_at", c."last_submission_at",
             c."last_submission_at" AS _cursor_ts, c."id" AS _cursor_id`,
    from: `"customers" c WHERE c."company_id" = $1 AND c."deleted_at" IS NULL`,
    cursorColumn: `c."last_submission_at"`,
  },
  purchases: {
    headers: [
      "Invoice number",
      "Amount",
      "Customer mobile",
      "Customer name",
      "Vehicle number",
      "Submitted at",
    ],
    columns: [
      "invoice_number",
      "invoice_amount",
      "mobile",
      "full_name_snapshot",
      "vehicle_number_snapshot",
      "submitted_at",
    ],
    select: `p."invoice_number", p."invoice_amount", cu."mobile",
             p."full_name_snapshot", p."vehicle_number_snapshot", p."submitted_at",
             p."submitted_at" AS _cursor_ts, p."id" AS _cursor_id`,
    from: `"purchases" p
             INNER JOIN "customers" cu ON cu."id" = p."customer_id"
           WHERE p."company_id" = $1 AND p."deleted_at" IS NULL`,
    cursorColumn: `p."submitted_at"`,
  },
};

interface Cursor {
  ts: Date;
  id: string;
}

export class ExportService {
  /**
   * Streams a dataset straight to the response, one batch at a time.
   *
   * **Batched keyset pagination, not a server-side cursor.** TypeORM's
   * `QueryBuilder.stream()` is the obvious tool and was the original plan, but it holds
   * a database connection open for the entire download. `data-source.ts` caps the pool
   * at 10, and a merchant pulling 36k rows over a phone connection can hold that open
   * for minutes — ten such downloads would take the whole API down. Batching releases
   * the connection between round trips, and it avoids adding `pg-query-stream`.
   *
   * **Keyset, not OFFSET.** `OFFSET n` makes Postgres walk and discard n rows on every
   * batch, so the cost grows quadratically with the export size — exactly the bug
   * bounded out of the pagination schema. It is also unstable: a submission arriving
   * mid-export shifts every subsequent page and silently drops a row.
   *
   * Three failure modes are handled explicitly, because all three corrupt or leak
   * otherwise:
   *
   *  1. **Error before the first byte** — rethrown, so the normal error handler can
   *     still send a proper JSON error.
   *  2. **Error after the first byte** — the 200 and its headers are already on the
   *     wire and cannot be retracted. `next(err)` would make the error handler attempt
   *     `res.json()` on a half-written response, producing a body that is neither valid
   *     CSV nor valid JSON. Destroying the socket is the only honest signal that the
   *     download is broken.
   *  3. **Client disconnects mid-download** — the loop checks and stops, rather than
   *     querying batch after batch for a response nobody is reading.
   */
  async streamDataset(
    dataset: ExportDataset,
    format: ExportFormat,
    companyId: string,
    res: Response,
  ): Promise<void> {
    const spec = DATASETS[dataset];
    let wroteFirstByte = false;
    let aborted = false;

    res.on("close", () => {
      if (!res.writableEnded) {
        aborted = true;
        logger.info({ companyId, dataset }, "Export aborted by the client");
      }
    });

    /** Honour backpressure: without this a fast DB fills the socket buffer in memory. */
    const write = async (chunk: string): Promise<void> => {
      wroteFirstByte = true;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    };

    try {
      // The FIRST batch is fetched before a single byte is written, deliberately.
      //
      // Emitting the header first felt natural and was wrong: it commits the 200, so
      // any query failure — a bad parameter, the database briefly unavailable — then
      // counts as "mid-stream" and can only be reported by destroying the socket. The
      // customer gets a truncated file instead of an error message. Doing one read
      // first means an outright failure still produces a clean JSON error, and the
      // socket is only ever destroyed once real data has already gone out.
      let cursor: Cursor | null = null;
      let rows = await this.fetchBatch(spec, companyId, cursor);
      let first = true;

      if (format === "csv") {
        await write(UTF8_BOM + csvRow(spec.headers));
      } else {
        await write("[");
      }

      for (;;) {
        if (aborted) return;
        if (rows.length === 0) break;

        const chunk: string[] = [];
        for (const row of rows) {
          if (format === "csv") {
            chunk.push(csvRow(spec.columns.map((c) => row[c])));
          } else {
            const obj: Record<string, unknown> = {};
            for (const c of spec.columns) obj[c] = row[c] ?? null;
            chunk.push(first ? JSON.stringify(obj) : `,${JSON.stringify(obj)}`);
            first = false;
          }
        }
        await write(chunk.join(""));

        if (rows.length < BATCH_SIZE) break;
        const last = rows[rows.length - 1]!;
        cursor = { ts: last["_cursor_ts"] as Date, id: last["_cursor_id"] as string };
        rows = await this.fetchBatch(spec, companyId, cursor);
      }

      if (format === "json") await write("]");
      res.end();
    } catch (err) {
      if (wroteFirstByte) {
        logger.error({ err, companyId, dataset }, "Export failed mid-stream");
        res.destroy();
        return;
      }
      throw err;
    }
  }

  /**
   * One batch, newest first.
   *
   * The keyset predicate is a row-value comparison — `(ts, id) < ($2, $3)` — which
   * Postgres evaluates as a single tuple comparison. Comparing the columns separately
   * (`ts < $2 OR (ts = $2 AND id < $3)`) is the usual hand-written version and is easy
   * to get subtly wrong when timestamps tie, which they do: bulk submissions land in
   * the same millisecond and the naive form then either skips or repeats them.
   */
  private async fetchBatch(
    spec: DatasetSpec,
    companyId: string,
    cursor: Cursor | null,
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
        LIMIT ${BATCH_SIZE}`,
      params,
    )) as Record<string, unknown>[];
  }

  /** `kimates-customers-2026-08-04.csv` — dated so repeat downloads don't collide. */
  filename(dataset: ExportDataset, format: ExportFormat): string {
    const date = new Date().toISOString().slice(0, 10);
    return `kimates-${dataset}-${date}.${format}`;
  }
}
