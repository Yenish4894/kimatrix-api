import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import type { PaymentKind, PaymentStatus } from "@/entities/Payment";
import { Payment } from "@/entities/Payment";

/** Raw row for reversal handling — snake_case because it comes straight from SQL. */
export interface ReversalPaymentRow {
  id: string;
  company_id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount: string;
  currency: string;
  subscription_starts_at: Date | null;
  subscription_ends_at: Date | null;
  paypal_response: Record<string, unknown> | null;
}

/** One payment as shown in payment history. snake_case: straight from SQL. */
export interface PaymentHistoryRow {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount: string;
  currency: string;
  captured_at: Date | null;
  created_at: Date;
  subscription_starts_at: Date | null;
  subscription_ends_at: Date | null;
  draw_spins: number;
  paypal_order_id: string | null;
  paypal_sale_id: string | null;
  plan_name: string | null;
  company_id: string;
  company_name: string;
}

/** History row plus the bill-to block an invoice prints. */
export interface InvoicePaymentRow extends PaymentHistoryRow {
  registration_number: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  contact_email: string | null;
}

export interface AdminPaymentFilters {
  page: number;
  limit: number;
  status?: PaymentStatus;
  kind?: PaymentKind;
  search?: string;
  from?: Date;
  to?: Date;
}

const HISTORY_COLUMNS = `p."id", p."kind", p."status", p."amount", p."currency",
       p."captured_at", p."created_at", p."subscription_starts_at", p."subscription_ends_at",
       p."draw_spins", p."paypal_order_id", p."paypal_sale_id",
       pl."name" AS "plan_name", c."id" AS "company_id", c."name" AS "company_name"`;

// LEFT JOIN on plans: plan_id is NOT NULL today, but an invoice must still render if a
// plan row ever went missing. Archived (soft-deleted) plans are joined on purpose, since
// a receipt names the plan that was bought, not the one on sale now.
const HISTORY_FROM = `FROM "payments" p
  JOIN "companies" c ON c."id" = p."company_id"
  LEFT JOIN "plans" pl ON pl."id" = p."plan_id"`;

/** Escape LIKE wildcards so a company named "100%" searches for itself. */
function likePattern(term: string): string {
  return `%${term.replaceAll(/[\\%_]/g, "\\$&")}%`;
}

/**
 * The exclusive upper bound for a `to` filter.
 *
 * A date-only value ("2026-09-13") arrives from Joi as midnight UTC, and `<=` midnight
 * would drop everything that happened on the day the admin actually picked. Midnight
 * is therefore read as "through the end of that day"; any other instant is inclusive.
 */
export function exclusiveUpperBound(to: Date): Date {
  const isMidnight =
    to.getUTCHours() === 0 &&
    to.getUTCMinutes() === 0 &&
    to.getUTCSeconds() === 0 &&
    to.getUTCMilliseconds() === 0;
  return new Date(to.getTime() + (isMidnight ? 24 * 60 * 60 * 1000 : 1));
}

export class PaymentRepository {
  private getRepo(manager?: EntityManager): Repository<Payment> {
    return manager ? manager.getRepository(Payment) : AppDataSource.getRepository(Payment);
  }

  async create(
    data: {
      companyId: string;
      planId: string;
      paypalOrderId: string;
      status: PaymentStatus;
      amount: number;
      currency: string;
      drawSpins?: number;
      kind?: PaymentKind;
      subscriptionStartsAt?: Date | null;
      subscriptionEndsAt?: Date | null;
    },
    manager?: EntityManager,
  ): Promise<Payment> {
    const repo = this.getRepo(manager);
    return repo.save(
      repo.create({
        company: { id: data.companyId } as never,
        plan: { id: data.planId } as never,
        paypalOrderId: data.paypalOrderId,
        status: data.status,
        kind: data.kind ?? "order",
        amount: String(data.amount),
        currency: data.currency,
        drawSpins: data.drawSpins ?? 0,
        capturedAt: null,
        subscriptionStartsAt: data.subscriptionStartsAt ?? null,
        subscriptionEndsAt: data.subscriptionEndsAt ?? null,
        paypalResponse: null,
      }),
    );
  }

  async findByPaypalOrderId(orderId: string, manager?: EntityManager): Promise<Payment | null> {
    return this.getRepo(manager).findOne({
      where: { paypalOrderId: orderId },
      relations: ["company", "plan"],
    });
  }

  async findByPaypalOrderIdForUpdate(
    orderId: string,
    manager: EntityManager,
  ): Promise<Payment | null> {
    // Lock ONLY the payments row (`FOR UPDATE OF p`). Postgres rejects `FOR UPDATE`
    // on the nullable side of a LEFT JOIN, so we must scope the lock to "p" while
    // still eager-loading company + plan for the capture logic.
    return manager
      .getRepository(Payment)
      .createQueryBuilder("p")
      .setLock("pessimistic_write", undefined, ["p"])
      .leftJoinAndSelect("p.company", "company")
      .leftJoinAndSelect("p.plan", "plan")
      .where("p.paypalOrderId = :orderId", { orderId })
      .getOne();
  }

  async findByIdForUpdate(id: string, manager: EntityManager): Promise<Payment | null> {
    // Same `FOR UPDATE OF p` scoping as above — Postgres rejects FOR UPDATE on the
    // nullable side of a LEFT JOIN.
    return manager
      .getRepository(Payment)
      .createQueryBuilder("p")
      .setLock("pessimistic_write", undefined, ["p"])
      .leftJoinAndSelect("p.company", "company")
      .leftJoinAndSelect("p.plan", "plan")
      .where("p.id = :id", { id })
      .getOne();
  }

  /**
   * Atomically move a payment from `pending` to `capturing`, returning it only if THIS
   * caller won the transition.
   *
   * This replaces holding a row lock across the PayPal HTTP call. The capture request
   * takes up to 15s, and doing it inside a transaction meant a timeout AFTER PayPal had
   * already debited the buyer rolled the row back to `pending` — money taken, nothing
   * granted — while also pinning one of only 10 pool connections for the duration.
   *
   * A single conditional UPDATE is its own mutual exclusion: two concurrent callers
   * cannot both match `status = 'pending'`.
   */
  async claimForCapture(
    orderId: string,
    companyId: string,
    manager?: EntityManager,
  ): Promise<Payment | null> {
    const result = await this.getRepo(manager)
      .createQueryBuilder()
      .update(Payment)
      .set({ status: "capturing" })
      .where("paypal_order_id = :orderId", { orderId })
      .andWhere("company_id = :companyId", { companyId })
      .andWhere("status = :pending", { pending: "pending" })
      .returning("id")
      .execute();

    const claimedId = (result.raw as { id: string }[] | undefined)?.[0]?.id;
    if (!claimedId) return null;
    return this.getRepo(manager).findOne({
      where: { id: claimedId },
      relations: ["company", "plan"],
    });
  }

  async updateCaptured(
    id: string,
    data: {
      status: PaymentStatus;
      capturedAt: Date;
      subscriptionStartsAt: Date;
      subscriptionEndsAt: Date;
      paypalResponse: Record<string, unknown>;
    },
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(id, {
      status: data.status,
      capturedAt: data.capturedAt,
      subscriptionStartsAt: data.subscriptionStartsAt,
      subscriptionEndsAt: data.subscriptionEndsAt,
      paypalResponse: data.paypalResponse as never,
    });
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    paypalResponse?: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(id, {
      status,
      ...(paypalResponse ? { paypalResponse: paypalResponse as never } : {}),
    });
  }

  /**
   * Locks the payment a PayPal reversal event refers to, by order id or capture id.
   *
   * Raw SQL with `FOR UPDATE` on the single row — no joins, for the same reason as the
   * other locking reads here. The capture id is not a column: it lives in
   * `paypal_response`, which holds either the synchronous capture body
   * (`purchase_units[0].payments.captures[0].id`) or, when the webhook finalized it, the
   * whole PAYMENT.CAPTURE.COMPLETED event (`resource.id`). That match is an unindexed
   * scan, acceptable because refunds are rare and `payments` is small; the order id,
   * which is indexed, is tried first whenever PayPal supplies it.
   */
  async findForReversalForUpdate(
    refs: { orderId: string | null; captureId: string | null },
    manager: EntityManager,
  ): Promise<ReversalPaymentRow | null> {
    const columns = `"id", "company_id", "kind", "status", "amount", "currency",
                     "subscription_starts_at", "subscription_ends_at", "paypal_response"`;
    if (refs.orderId) {
      const rows = (await manager.query(
        `SELECT ${columns} FROM "payments" WHERE "paypal_order_id" = $1 FOR UPDATE`,
        [refs.orderId],
      )) as ReversalPaymentRow[];
      if (rows[0]) return rows[0];
    }
    if (refs.captureId) {
      const rows = (await manager.query(
        `SELECT ${columns} FROM "payments"
          WHERE "paypal_response" #>> '{purchase_units,0,payments,captures,0,id}' = $1
             OR "paypal_response" #>> '{resource,id}' = $1
          ORDER BY "created_at" DESC
          LIMIT 1
          FOR UPDATE`,
        [refs.captureId],
      )) as ReversalPaymentRow[];
      if (rows[0]) return rows[0];
    }
    return null;
  }

  /**
   * A company's own billing history: only money that actually moved (captured, or
   * captured then refunded). Pending and failed attempts are noise to a customer.
   * Ordered by when it was paid, falling back to creation for safety.
   */
  async listHistoryForCompany(
    companyId: string,
    page: number,
    limit: number,
  ): Promise<{ items: PaymentHistoryRow[]; total: number }> {
    const where = `WHERE p."company_id" = $1
         AND p."status" IN ('captured', 'refunded')
         AND p."deleted_at" IS NULL`;
    const [items, count] = await Promise.all([
      AppDataSource.query(
        `SELECT ${HISTORY_COLUMNS}
           ${HISTORY_FROM}
          ${where}
          ORDER BY COALESCE(p."captured_at", p."created_at") DESC, p."id" DESC
          LIMIT $2 OFFSET $3`,
        [companyId, limit, (page - 1) * limit],
      ) as Promise<PaymentHistoryRow[]>,
      AppDataSource.query(`SELECT COUNT(*)::int AS "total" FROM "payments" p ${where}`, [
        companyId,
      ]) as Promise<{ total: number }[]>,
    ]);
    return { items, total: count[0]?.total ?? 0 };
  }

  /** Every company's payments, every status unless filtered. */
  async listHistoryForAdmin(
    f: AdminPaymentFilters,
  ): Promise<{ items: PaymentHistoryRow[]; total: number }> {
    const conds = [`p."deleted_at" IS NULL`];
    const params: unknown[] = [];
    const add = (sql: (n: string) => string, value: unknown) => {
      params.push(value);
      conds.push(sql(`$${params.length}`));
    };
    if (f.status) add((n) => `p."status" = ${n}`, f.status);
    if (f.kind) add((n) => `p."kind" = ${n}`, f.kind);
    if (f.search && f.search.trim() !== "") {
      add((n) => `c."name" ILIKE ${n}`, likePattern(f.search.trim()));
    }
    if (f.from) add((n) => `p."created_at" >= ${n}`, f.from);
    if (f.to) add((n) => `p."created_at" < ${n}`, exclusiveUpperBound(f.to));
    const where = `WHERE ${conds.join(" AND ")}`;

    const [items, count] = await Promise.all([
      AppDataSource.query(
        `SELECT ${HISTORY_COLUMNS}
           ${HISTORY_FROM}
          ${where}
          ORDER BY p."created_at" DESC, p."id" DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, f.limit, (f.page - 1) * f.limit],
      ) as Promise<PaymentHistoryRow[]>,
      AppDataSource.query(
        `SELECT COUNT(*)::int AS "total"
           FROM "payments" p
           JOIN "companies" c ON c."id" = p."company_id"
          ${where}`,
        params,
      ) as Promise<{ total: number }[]>,
    ]);
    return { items, total: count[0]?.total ?? 0 };
  }

  /**
   * One invoiceable payment. `companyId` scopes it to the caller's own company; pass
   * null for admin. A payment that exists but belongs to someone else comes back as
   * null, the same as one that does not exist, so the route can 404 without revealing
   * which ids are real.
   */
  async findInvoiceRow(
    paymentId: string,
    companyId: string | null,
  ): Promise<InvoicePaymentRow | null> {
    const rows = (await AppDataSource.query(
      `SELECT ${HISTORY_COLUMNS},
              c."registration_number", c."street_address", c."city", c."state",
              c."postal_code", c."country", c."contact_email"
         ${HISTORY_FROM}
        WHERE p."id" = $1
          AND p."status" IN ('captured', 'refunded')
          AND p."deleted_at" IS NULL
          AND ($2::uuid IS NULL OR p."company_id" = $2::uuid)`,
      [paymentId, companyId],
    )) as InvoicePaymentRow[];
    return rows[0] ?? null;
  }

  async findByCompany(companyId: string, manager?: EntityManager): Promise<Payment[]> {
    return this.getRepo(manager).find({
      where: { company: { id: companyId } },
      relations: ["plan"],
      order: { createdAt: "DESC" },
    });
  }
}
