import type { EntityManager } from "typeorm";

/** One plan window in which a company may spend lucky draw spins. */
export interface DrawPeriod {
  /** `payment:<id>` or `comp:<granted-at epoch ms>` — what a spin is counted against. */
  periodKey: string;
  source: "payment" | "comp" | "trial";
  paymentId: string | null;
  periodStart: Date;
  /** Null for a comp with no end date. */
  periodEnd: Date | null;
  spins: number;
  used: number;
}

export interface DrawEntry {
  purchaseId: string;
  customerId: string;
  fullName: string;
  mobile: string;
  vehicleNumber: string | null;
  invoiceNumber: string;
  invoiceAmount: string;
  submittedAt: Date;
}

export interface DrawHistoryRow extends Omit<DrawEntry, "customerId" | "purchaseId"> {
  id: string;
  source: "payment" | "comp" | "trial";
  periodStart: Date;
  periodEnd: Date | null;
  entriesCount: number;
  eligibleCustomers: number;
  drawnAt: Date;
  /** Null once the winning purchase has been erased (expiry purge or account closure). */
  purchaseId: string | null;
  /**
   * True when the winner's customer or purchase row is gone and the details come from
   * the snapshot taken at draw time: the mobile is then masked to its last four digits.
   */
  fromSnapshot: boolean;
}

/**
 * What the draw keeps of the winner's mobile once the customer row may be erased: the
 * last four digits, enough to confirm "yes, that was me" in a prize dispute. Must match
 * the backfill in migration 1787112000000-luckyDrawSurvivesPurge.
 */
export function maskMobile(mobile: string): string {
  const compact = mobile.replace(/\s+/g, "");
  return compact.length <= 4 ? "****" : `****${compact.slice(-4)}`;
}

/**
 * The company's running trial and comp periods, each keyed as its draws are recorded:
 * `comp:<window start ms>` / `trial:<trial start ms>`. Both may run at once (a company
 * comped mid-trial). $1 = company id, $2 = now. `rank` orders comp before trial, as
 * computeEntitlement does.
 */
const FREE_PERIODS_SQL = `
  SELECT 'comp:' || floor(extract(epoch FROM c."comp_draw_spins_granted_at") * 1000)::bigint
           AS period_key,
         'comp'::text AS source, 1 AS rank,
         c."comp_draw_spins_granted_at" AS period_start, c."comped_until" AS period_end
    FROM "companies" c
   WHERE c."id" = $1 AND c."deactivated_at" IS NULL
     AND c."is_comped" = true
     AND c."comp_draw_spins_granted_at" IS NOT NULL
     AND (c."comped_until" IS NULL OR c."comped_until" > $2)
  UNION ALL
  SELECT 'trial:' || floor(extract(epoch FROM c."trial_started_at") * 1000)::bigint,
         'trial', 2, c."trial_started_at", c."trial_ends_at"
    FROM "companies" c
   WHERE c."id" = $1 AND c."deactivated_at" IS NULL
     AND c."trial_started_at" IS NOT NULL
     AND c."trial_started_at" <= $2
     AND c."trial_ends_at" > $2`;

export interface FreeDrawPeriod {
  periodKey: string;
  source: "comp" | "trial";
  periodStart: Date;
  periodEnd: Date | null;
}

interface FreeDrawPeriodRow {
  period_key: string;
  source: "comp" | "trial";
  period_start: Date;
  period_end: Date | null;
}

function toFreeDrawPeriod(r: FreeDrawPeriodRow): FreeDrawPeriod {
  return {
    periodKey: r.period_key,
    source: r.source,
    periodStart: new Date(r.period_start),
    periodEnd: r.period_end ? new Date(r.period_end) : null,
  };
}

/**
 * The purchases that are in the pool for a period: this company's, submitted inside
 * the window, and not belonging to anyone who has already won in it. Shared by the
 * count and the pick so the two can never disagree about who is eligible — if they
 * did, the random offset could point past the end of the list.
 */
const ELIGIBLE_WHERE = `
  p."company_id" = $1
  AND p."deleted_at" IS NULL
  AND p."voided_at" IS NULL
  AND cu."deleted_at" IS NULL
  AND p."submitted_at" >= $2
  AND ($3::timestamptz IS NULL OR p."submitted_at" < $3)
  AND p."customer_id" NOT IN (
    SELECT d."winner_customer_id" FROM "lucky_draws" d
     WHERE d."company_id" = $1
       -- A period and its bought pool ("buy:" + key) are one period for winners.
       AND regexp_replace(d."period_key", '^buy:', '') = regexp_replace($4::text, '^buy:', '')
       -- Required since winners became nullable (erased customers): one NULL in a
       -- NOT IN list makes the whole predicate NULL, and nobody would be eligible.
       AND d."winner_customer_id" IS NOT NULL
  )`;

/**
 * Raw SQL rather than an entity, in the same style as the claim queries in
 * CompanyRepository: every read here is an aggregate or a window over purchases, and
 * the ORM would add nothing but a second place for the eligibility rule to drift.
 */
export class LuckyDrawRepository {
  /**
   * Serialises spins for one company. Without it, two clicks (or two tabs) could both
   * read "1 spin remaining" and both spend it. The unique index on winners
   * (uq_lucky_draws_one_win_per_base_period, which spans a period and its bought pool)
   * would stop the same customer winning twice, but not a spin being used twice.
   */
  async lockCompany(companyId: string, manager: EntityManager): Promise<void> {
    await manager.query(`SELECT "id" FROM "companies" WHERE "id" = $1 FOR UPDATE`, [companyId]);
  }

  /**
   * The free period (comp, else trial) a spin bought right now is bought for, keyed
   * exactly as `activePeriods` keys it. Undefined when neither is running. A comp ranks
   * first, as in computeEntitlement. Computed in SQL, not JS, so the key's millisecond
   * rounding can never differ from the draws already recorded under it.
   */
  async freeDrawPeriod(
    companyId: string,
    now: Date,
    manager: EntityManager,
  ): Promise<FreeDrawPeriod | undefined> {
    const rows = (await manager.query(
      `SELECT * FROM (${FREE_PERIODS_SQL}) f ORDER BY f.rank LIMIT 1`,
      [companyId, now],
    )) as FreeDrawPeriodRow[];
    return rows[0] ? toFreeDrawPeriod(rows[0]) : undefined;
  }

  /**
   * Whether the trial or comp period named by `periodKey` is still running. Used at
   * capture: a trial purchase must not be refused just because a comp was granted
   * while the buyer was on PayPal (the comp would outrank it in `freeDrawPeriod`).
   */
  async freeDrawPeriodOpen(
    companyId: string,
    periodKey: string,
    now: Date,
    manager: EntityManager,
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM (${FREE_PERIODS_SQL}) f WHERE f.period_key = $3`,
      [companyId, now, periodKey],
    )) as unknown[];
    return rows.length > 0;
  }

  /**
   * Windows that are open right now and include spins, soonest-ending first.
   *
   * Spins bought on a trial or comp are their OWN pool (`buy:<period key>`), next to the
   * period's free spins rather than added to them. Mixed into one count, a later drop in
   * the free spins (the admin lowering the trial setting, or the company paying or being
   * comped mid-trial, which zeroes $3) ate the paid ones first. Separate, the paid spins
   * are counted only against draws made from them. Within one window the free pool sorts
   * first, so free spins are always used before paid ones. ELIGIBLE_WHERE treats the two
   * as one period for winners: nobody wins twice in a trial or comp.
   *
   * @param trialSpins  Free spins for the company's running trial, or 0. The caller
   *   decides — it knows whether the trial is what grants access right now (a company
   *   that paid or was comped mid-trial isn't "on trial"), which this query can't see.
   */
  async activePeriods(
    companyId: string,
    now: Date,
    manager: EntityManager,
    trialSpins = 0,
  ): Promise<DrawPeriod[]> {
    const rows = (await manager.query(
      `WITH free AS (${FREE_PERIODS_SQL}),
       bought AS (
         -- Captured spins bought on a trial or comp, by the period they were bought for.
         SELECT b."draw_period_key", sum(b."draw_spins")::int AS spins
           FROM "payments" b
          WHERE b."company_id" = $1
            AND b."kind" = 'spin_addon'
            AND b."status" = 'captured'
            AND b."draw_period_key" IS NOT NULL
          GROUP BY b."draw_period_key"
       ),
       periods AS (
         SELECT 'paid:' || floor(extract(epoch FROM p."subscription_starts_at") * 1000)::bigint
                         || ':' || floor(extract(epoch FROM p."subscription_ends_at") * 1000)::bigint AS period_key,
                'payment'::text               AS source,
                -- The earliest payment in the window stands for the group. Not min(id):
                -- PostgreSQL has no min() aggregate for uuid in every supported version.
                (array_agg(p."id" ORDER BY p."captured_at", p."id"))[1] AS payment_id,
                p."subscription_starts_at"    AS period_start,
                p."subscription_ends_at"      AS period_end,
                sum(p."draw_spins")::int      AS spins,
                0                             AS pool_order
           FROM "payments" p
          WHERE p."company_id" = $1
            AND p."status" = 'captured'
            AND p."draw_spins" > 0
            -- Plan-less add-ons belong to a trial/comp period (the bought pools below).
            AND p."draw_period_key" IS NULL
            AND p."subscription_starts_at" <= $2
            AND p."subscription_ends_at" > $2
          GROUP BY p."subscription_starts_at", p."subscription_ends_at"
         UNION ALL
         -- The comp's free spins.
         SELECT f.period_key, 'comp', NULL::uuid, f.period_start, f.period_end,
                c."comp_draw_spins", 0
           FROM free f JOIN "companies" c ON c."id" = $1
          WHERE f.source = 'comp' AND c."comp_draw_spins" > 0
         UNION ALL
         -- The running trial's free spins, with the admin's live setting passed in as $3.
         -- Keyed on the trial's start so a later trial (after an admin reset) gets its
         -- own count rather than inheriting spins used in an earlier one.
         SELECT f.period_key, 'trial', NULL::uuid, f.period_start, f.period_end, $3::int, 0
           FROM free f
          WHERE f.source = 'trial' AND $3::int > 0
         UNION ALL
         -- Spins bought on that trial / comp: usable while it runs, extensions included.
         SELECT 'buy:' || f.period_key, f.source, NULL::uuid, f.period_start, f.period_end,
                b.spins, 1
           FROM free f JOIN bought b ON b."draw_period_key" = f.period_key
       )
       SELECT pr.*,
              (SELECT count(*)::int FROM "lucky_draws" d
                WHERE d."company_id" = $1 AND d."period_key" = pr.period_key) AS used
         FROM periods pr
        ORDER BY pr.period_end ASC NULLS LAST, pr.pool_order ASC`,
      [companyId, now, trialSpins],
    )) as {
      period_key: string;
      source: "payment" | "comp" | "trial";
      payment_id: string | null;
      period_start: Date;
      period_end: Date | null;
      spins: number;
      used: number;
    }[];
    return rows.map((r) => ({
      periodKey: r.period_key,
      source: r.source,
      paymentId: r.payment_id,
      periodStart: new Date(r.period_start),
      periodEnd: r.period_end ? new Date(r.period_end) : null,
      spins: Number(r.spins),
      used: Number(r.used),
    }));
  }

  async countEligible(
    companyId: string,
    period: DrawPeriod,
    manager: EntityManager,
  ): Promise<{ entries: number; customers: number }> {
    const [row] = (await manager.query(
      `SELECT count(*)::int AS entries, count(DISTINCT p."customer_id")::int AS customers
         FROM "purchases" p JOIN "customers" cu ON cu."id" = p."customer_id"
        WHERE ${ELIGIBLE_WHERE}`,
      [companyId, period.periodStart, period.periodEnd, period.periodKey],
    )) as { entries: number; customers: number }[];
    return { entries: Number(row?.entries ?? 0), customers: Number(row?.customers ?? 0) };
  }

  /**
   * Counts the eligible pool AND picks the winner in one statement.
   *
   * Every purchase — and so every customer, in proportion to how often they bought — has
   * the same chance: the winner is the row at `seed % entries` in a stable ordering, and
   * the caller's seed is uniform (see utils/luckyDraw).
   *
   * One statement because it is one snapshot. The previous count-then-pick ran as two
   * statements under READ COMMITTED, each with its own snapshot, so a purchase voided in
   * between shifted the ordering: the last entry could never win and an offset could
   * point past the end. The returned counts are the pool the pick was actually made
   * from, which is what the draw record must state.
   */
  async pickRandomEntry(
    companyId: string,
    period: DrawPeriod,
    seed: number,
    manager: EntityManager,
  ): Promise<{ entry: DrawEntry | null; entries: number; customers: number }> {
    const [row] = (await manager.query(
      `WITH pool AS (
         SELECT p."id" AS purchase_id, p."customer_id", cu."full_name", cu."mobile",
                cu."vehicle_number", p."invoice_number", p."invoice_amount", p."submitted_at",
                row_number() OVER (ORDER BY p."submitted_at", p."id") - 1 AS rn
           FROM "purchases" p JOIN "customers" cu ON cu."id" = p."customer_id"
          WHERE ${ELIGIBLE_WHERE}
       ), totals AS (
         SELECT count(*)::int AS entries, count(DISTINCT customer_id)::int AS customers
           FROM pool
       )
       SELECT t.entries, t.customers, w.*
         FROM totals t
         LEFT JOIN pool w
           ON t.entries > 0 AND w.rn = ($5::bigint % t.entries)`,
      [companyId, period.periodStart, period.periodEnd, period.periodKey, String(seed)],
    )) as Record<string, unknown>[];
    const entries = Number(row?.["entries"] ?? 0);
    const customers = Number(row?.["customers"] ?? 0);
    if (!row || row["purchase_id"] == null) return { entry: null, entries, customers };
    return { entry: this.toEntry(row), entries, customers };
  }

  private toEntry(row: Record<string, unknown>): DrawEntry {
    return {
      purchaseId: String(row["purchase_id"]),
      customerId: String(row["customer_id"]),
      fullName: String(row["full_name"]),
      mobile: String(row["mobile"]),
      vehicleNumber: (row["vehicle_number"] as string | null) ?? null,
      invoiceNumber: String(row["invoice_number"]),
      invoiceAmount: String(row["invoice_amount"]),
      submittedAt: new Date(row["submitted_at"] as string),
    };
  }

  async insertDraw(
    params: {
      companyId: string;
      period: DrawPeriod;
      entry: DrawEntry;
      entriesCount: number;
      eligibleCustomers: number;
      drawnByUserId: string;
    },
    manager: EntityManager,
  ): Promise<{ id: string; drawnAt: Date }> {
    // The snapshot columns are what survive if the customer or purchase is later
    // erased; see migration 1787112000000-luckyDrawSurvivesPurge.
    const [row] = (await manager.query(
      `INSERT INTO "lucky_draws"
         ("company_id", "period_key", "source", "payment_id", "period_start", "period_end",
          "winner_customer_id", "winning_purchase_id", "entries_count", "eligible_customers",
          "drawn_by_user_id", "winner_name", "winner_mobile_masked", "invoice_number",
          "invoice_amount", "purchase_submitted_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING "id", "created_at"`,
      [
        params.companyId,
        params.period.periodKey,
        params.period.source,
        params.period.paymentId,
        params.period.periodStart,
        params.period.periodEnd,
        params.entry.customerId,
        params.entry.purchaseId,
        params.entriesCount,
        params.eligibleCustomers,
        params.drawnByUserId,
        params.entry.fullName,
        maskMobile(params.entry.mobile),
        params.entry.invoiceNumber,
        params.entry.invoiceAmount,
        params.entry.submittedAt,
      ],
    )) as { id: string; created_at: Date }[];
    return { id: row!.id, drawnAt: new Date(row!.created_at) };
  }

  async history(companyId: string, manager: EntityManager): Promise<DrawHistoryRow[]> {
    // LEFT JOINs: a draw whose winner was erased still appears, from its snapshot.
    const rows = (await manager.query(
      `SELECT d."id", d."source", d."period_start", d."period_end", d."entries_count",
              d."eligible_customers", d."created_at", d."winning_purchase_id",
              (cu."id" IS NULL OR pu."id" IS NULL) AS from_snapshot,
              COALESCE(cu."full_name", d."winner_name") AS full_name,
              COALESCE(cu."mobile", d."winner_mobile_masked") AS mobile,
              cu."vehicle_number",
              COALESCE(pu."invoice_number", d."invoice_number") AS invoice_number,
              COALESCE(pu."invoice_amount", d."invoice_amount") AS invoice_amount,
              COALESCE(pu."submitted_at", d."purchase_submitted_at", d."created_at") AS submitted_at
         FROM "lucky_draws" d
         LEFT JOIN "customers" cu ON cu."id" = d."winner_customer_id"
         LEFT JOIN "purchases" pu ON pu."id" = d."winning_purchase_id"
        WHERE d."company_id" = $1
        ORDER BY d."created_at" DESC
        LIMIT 50`,
      [companyId],
    )) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r["id"]),
      source: r["source"] as "payment" | "comp" | "trial",
      periodStart: new Date(r["period_start"] as string),
      periodEnd: r["period_end"] ? new Date(r["period_end"] as string) : null,
      entriesCount: Number(r["entries_count"]),
      eligibleCustomers: Number(r["eligible_customers"]),
      drawnAt: new Date(r["created_at"] as string),
      purchaseId: (r["winning_purchase_id"] as string | null) ?? null,
      fromSnapshot: Boolean(r["from_snapshot"]),
      // Null only after an account closure scrubbed the snapshot too.
      fullName: (r["full_name"] as string | null) ?? "Erased customer",
      mobile: (r["mobile"] as string | null) ?? "",
      vehicleNumber: (r["vehicle_number"] as string | null) ?? null,
      invoiceNumber: (r["invoice_number"] as string | null) ?? "",
      invoiceAmount: (r["invoice_amount"] as string | null) ?? "0",
      submittedAt: new Date(r["submitted_at"] as string),
    }));
  }
}
