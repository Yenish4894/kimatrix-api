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

export interface DrawHistoryRow extends Omit<DrawEntry, "customerId"> {
  id: string;
  source: "payment" | "comp" | "trial";
  periodStart: Date;
  periodEnd: Date | null;
  entriesCount: number;
  eligibleCustomers: number;
  drawnAt: Date;
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
  AND cu."deleted_at" IS NULL
  AND p."submitted_at" >= $2
  AND ($3::timestamptz IS NULL OR p."submitted_at" < $3)
  AND p."customer_id" NOT IN (
    SELECT d."winner_customer_id" FROM "lucky_draws" d
     WHERE d."company_id" = $1 AND d."period_key" = $4
  )`;

/**
 * Raw SQL rather than an entity, in the same style as the claim queries in
 * CompanyRepository: every read here is an aggregate or a window over purchases, and
 * the ORM would add nothing but a second place for the eligibility rule to drift.
 */
export class LuckyDrawRepository {
  /**
   * Serialises spins for one company. Without it, two clicks (or two tabs) could both
   * read "1 spin remaining" and both spend it. The unique index on winners would stop
   * the same customer winning twice, but not a spin being used twice.
   */
  async lockCompany(companyId: string, manager: EntityManager): Promise<void> {
    await manager.query(`SELECT "id" FROM "companies" WHERE "id" = $1 FOR UPDATE`, [companyId]);
  }

  /**
   * Windows that are open right now and include spins, soonest-ending first.
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
      `WITH periods AS (
         SELECT 'paid:' || floor(extract(epoch FROM p."subscription_starts_at") * 1000)::bigint
                         || ':' || floor(extract(epoch FROM p."subscription_ends_at") * 1000)::bigint AS period_key,
                'payment'::text               AS source,
                -- The earliest payment in the window stands for the group. Not min(id):
                -- PostgreSQL has no min() aggregate for uuid in every supported version.
                (array_agg(p."id" ORDER BY p."captured_at", p."id"))[1] AS payment_id,
                p."subscription_starts_at"    AS period_start,
                p."subscription_ends_at"      AS period_end,
                sum(p."draw_spins")::int      AS spins
           FROM "payments" p
          WHERE p."company_id" = $1
            AND p."status" = 'captured'
            AND p."draw_spins" > 0
            AND p."subscription_starts_at" <= $2
            AND p."subscription_ends_at" > $2
          GROUP BY p."subscription_starts_at", p."subscription_ends_at"
         UNION ALL
         SELECT 'comp:' || floor(extract(epoch FROM c."comp_draw_spins_granted_at") * 1000)::bigint,
                'comp'::text,
                NULL::uuid,
                c."comp_draw_spins_granted_at",
                c."comped_until",
                c."comp_draw_spins"
           FROM "companies" c
          WHERE c."id" = $1
            AND c."is_comped" = true
            AND c."deactivated_at" IS NULL
            AND c."comp_draw_spins" > 0
            AND c."comp_draw_spins_granted_at" IS NOT NULL
            AND (c."comped_until" IS NULL OR c."comped_until" > $2)
         UNION ALL
         -- The running trial, with the admin's live spin setting passed in as $3.
         -- Keyed on the trial's start so a later trial (after an admin reset) gets its
         -- own count rather than inheriting spins used in an earlier one.
         SELECT 'trial:' || floor(extract(epoch FROM c."trial_started_at") * 1000)::bigint,
                'trial'::text,
                NULL::uuid,
                c."trial_started_at",
                c."trial_ends_at",
                $3::int
           FROM "companies" c
          WHERE c."id" = $1
            AND $3::int > 0
            AND c."deactivated_at" IS NULL
            AND c."trial_started_at" IS NOT NULL
            AND c."trial_started_at" <= $2
            AND c."trial_ends_at" > $2
       )
       SELECT pr.*,
              (SELECT count(*)::int FROM "lucky_draws" d
                WHERE d."company_id" = $1 AND d."period_key" = pr.period_key) AS used
         FROM periods pr
        ORDER BY pr.period_end ASC NULLS LAST`,
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
   * The purchase at `offset` in a stable ordering of the eligible pool. The caller
   * supplies a uniformly random offset, so every purchase — and therefore every
   * customer in proportion to how often they bought — has the same chance.
   */
  async pickEntry(
    companyId: string,
    period: DrawPeriod,
    offset: number,
    manager: EntityManager,
  ): Promise<DrawEntry | null> {
    const [row] = (await manager.query(
      `SELECT p."id" AS purchase_id, p."customer_id", cu."full_name", cu."mobile",
              cu."vehicle_number", p."invoice_number", p."invoice_amount", p."submitted_at"
         FROM "purchases" p JOIN "customers" cu ON cu."id" = p."customer_id"
        WHERE ${ELIGIBLE_WHERE}
        ORDER BY p."submitted_at", p."id"
        OFFSET $5 LIMIT 1`,
      [companyId, period.periodStart, period.periodEnd, period.periodKey, offset],
    )) as Record<string, unknown>[];
    if (!row) return null;
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
    const [row] = (await manager.query(
      `INSERT INTO "lucky_draws"
         ("company_id", "period_key", "source", "payment_id", "period_start", "period_end",
          "winner_customer_id", "winning_purchase_id", "entries_count", "eligible_customers",
          "drawn_by_user_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      ],
    )) as { id: string; created_at: Date }[];
    return { id: row!.id, drawnAt: new Date(row!.created_at) };
  }

  async history(companyId: string, manager: EntityManager): Promise<DrawHistoryRow[]> {
    const rows = (await manager.query(
      `SELECT d."id", d."source", d."period_start", d."period_end", d."entries_count",
              d."eligible_customers", d."created_at",
              d."winning_purchase_id", cu."full_name", cu."mobile", cu."vehicle_number",
              pu."invoice_number", pu."invoice_amount", pu."submitted_at"
         FROM "lucky_draws" d
         JOIN "customers" cu ON cu."id" = d."winner_customer_id"
         JOIN "purchases" pu ON pu."id" = d."winning_purchase_id"
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
      purchaseId: String(r["winning_purchase_id"]),
      fullName: String(r["full_name"]),
      mobile: String(r["mobile"]),
      vehicleNumber: (r["vehicle_number"] as string | null) ?? null,
      invoiceNumber: String(r["invoice_number"]),
      invoiceAmount: String(r["invoice_amount"]),
      submittedAt: new Date(r["submitted_at"] as string),
    }));
  }
}
