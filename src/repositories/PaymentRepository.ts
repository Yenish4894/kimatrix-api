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

  async findByCompany(companyId: string, manager?: EntityManager): Promise<Payment[]> {
    return this.getRepo(manager).find({
      where: { company: { id: companyId } },
      relations: ["plan"],
      order: { createdAt: "DESC" },
    });
  }
}
