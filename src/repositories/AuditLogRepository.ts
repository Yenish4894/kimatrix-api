import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import type { AuditLogQueryInput } from "@/validation/schemas/admin.schema";

/** One `admin_audit_log` row as the admin list reads it. snake_case: straight from SQL. */
export interface AuditLogRow {
  id: string;
  created_at: Date;
  actor_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Raw reads and system writes on `admin_audit_log`.
 *
 * Human-actor rows still go through AuditService (the entity repository). The raw
 * inserts here exist because a system row has no user: `actor_user_id` is nullable (SET
 * NULL on user deletion) while AuditService requires a user id.
 */
export class AuditLogRepository {
  /**
   * The audit trail, newest first.
   *
   * `companyId` matches rows about the company itself (entity_id = companyId) and rows
   * about its payments, its purchases (voids) and its owner's login (email changes),
   * whose entity_id is that row's id rather than the company's.
   *
   * `to` as a bare date (YYYY-MM-DD) includes that whole UTC day; as a full timestamp
   * it is used inclusively as given.
   */
  async listForAdmin(q: AuditLogQueryInput): Promise<{ total: number; rows: AuditLogRow[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (q.companyId) {
      // Bound twice: once compared with the varchar entity_id, once with uuid columns,
      // so Postgres infers each parameter's type cleanly and the uuid indexes are used.
      const asText = bind(q.companyId);
      const asUuid = bind(q.companyId);
      where.push(`(
          a."entity_id" = ${asText}
          OR (a."entity_type" = 'payment' AND a."entity_id" IN (
                SELECT pay."id"::text FROM "payments" pay WHERE pay."company_id" = ${asUuid}))
          OR (a."entity_type" = 'purchase' AND a."entity_id" IN (
                SELECT pu."id"::text FROM "purchases" pu WHERE pu."company_id" = ${asUuid}))
          OR (a."entity_type" = 'user' AND a."entity_id" IN (
                SELECT co."owner_user_id"::text FROM "companies" co WHERE co."id" = ${asUuid}))
          OR (a."entity_type" = 'trial_identity' AND a."entity_id" IN (
                SELECT ti."id"::text FROM "trial_identities" ti WHERE ti."company_id" = ${asUuid}))
        )`);
    }
    if (q.action) where.push(`a."action" = ${bind(q.action)}`);
    if (q.from) where.push(`a."created_at" >= ${bind(q.from)}`);
    if (q.to !== undefined) {
      if (typeof q.to === "string") {
        const [y, m, d] = q.to.split("-").map(Number) as [number, number, number];
        where.push(`a."created_at" < ${bind(new Date(Date.UTC(y, m - 1, d + 1)))}`);
      } else {
        where.push(`a."created_at" <= ${bind(q.to)}`);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const [countRow] = (await AppDataSource.query(
      `SELECT count(*)::int AS total FROM "admin_audit_log" a ${whereSql}`,
      [...params],
    )) as { total: number }[];

    const limitParam = bind(q.limit);
    const offsetParam = bind((q.page - 1) * q.limit);
    const rows = (await AppDataSource.query(
      `SELECT a."id", a."created_at", a."actor_email", a."action", a."entity_type",
              a."entity_id", a."note", a."before", a."after"
         FROM "admin_audit_log" a
         ${whereSql}
        ORDER BY a."created_at" DESC, a."id" DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    )) as AuditLogRow[];

    return { total: Number(countRow?.total ?? 0), rows };
  }

  /**
   * A system-actor row about a payment (refund, partial refund), in the caller's
   * transaction so the trail cannot disagree with the change.
   */
  async insertSystemPaymentEntry(
    manager: EntityManager,
    entry: {
      actorEmail: string;
      action: string;
      paymentId: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      note: string;
    },
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "admin_audit_log"
         ("actor_user_id", "actor_email", "action", "entity_type", "entity_id",
          "before", "after", "note")
       VALUES (NULL, $1, $2, 'payment', $3, $4, $5, $6)`,
      [
        entry.actorEmail,
        entry.action,
        entry.paymentId,
        JSON.stringify(entry.before),
        JSON.stringify(entry.after),
        entry.note,
      ],
    );
  }

  /**
   * Records a recurring sale that was NOT credited because its amount/currency differs
   * from every candidate plan. At most one row per sale id: a replayed event for the
   * same sale must not add a second row (the NOT EXISTS).
   */
  async insertAmountMismatchOnce(
    manager: EntityManager,
    entry: {
      actorEmail: string;
      saleId: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      note: string;
    },
  ): Promise<void> {
    await manager.query(
      // NOT EXISTS: a replayed event for the same sale must not add a second row.
      `INSERT INTO "admin_audit_log"
               ("actor_user_id", "actor_email", "action", "entity_type", "entity_id",
                "before", "after", "note")
             -- Explicit casts: parameters in a SELECT list are not typed from the
             -- target columns the way VALUES parameters are.
             SELECT NULL::uuid, $1::varchar, 'payment.amount_mismatch', 'paypal_sale',
                    $2::varchar, $3::jsonb, $4::jsonb, $5::varchar
              WHERE NOT EXISTS (SELECT 1 FROM "admin_audit_log"
                                 WHERE "action" = 'payment.amount_mismatch'
                                   AND "entity_id" = $2::varchar)`,
      [
        entry.actorEmail,
        entry.saleId,
        JSON.stringify(entry.before),
        JSON.stringify(entry.after),
        entry.note,
      ],
    );
  }
}
