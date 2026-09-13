import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import type { Company } from "@/entities/Company";
import type { Plan } from "@/entities/Plan";
import { Subscription, type SubscriptionState } from "@/entities/Subscription";
import { returningRows } from "@/utils/db";

/** The locked subscription row applyRemoteState works from. snake_case: straight from SQL. */
export interface LockedSubscriptionRow {
  id: string;
  company_id: string;
  status: SubscriptionState;
  last_event_at: Date | null;
}

/** The locked subscription + trial end creditCycle works from. */
export interface LockedCycleRow {
  id: string;
  company_id: string;
  plan_id: string;
  trial_ends_at: Date | null;
}

/** The plan a recurring sale is credited against. */
export interface CyclePlanRow {
  id: string;
  duration_days: number;
  price: string;
  currency: string;
}

/** Who to tell that a renewal failed, and whether it is still failing. */
export interface RenewalFailedRow {
  subscription_id: string;
  status: string;
  company_name: string;
  subscription_expires_at: Date | null;
  email: string;
  user_active: boolean;
}

/**
 * `subscriptions` — PayPal recurring subscriptions.
 *
 * The locking reads are raw SQL on purpose: `setLock("pessimistic_write")` puts FOR
 * UPDATE on the whole statement, and Postgres rejects FOR UPDATE against the nullable
 * side of a LEFT JOIN — so the QueryBuilder-with-joins version fails at runtime.
 * Selecting the FK column directly locks exactly the one row intended.
 */
export class SubscriptionRepository {
  private getRepo(manager?: EntityManager): Repository<Subscription> {
    return manager
      ? manager.getRepository(Subscription)
      : AppDataSource.getRepository(Subscription);
  }

  /** Inserts the local `pending` row before the buyer is sent to PayPal. */
  async createPending(
    companyId: string,
    planId: string,
    manager: EntityManager,
  ): Promise<Subscription> {
    const row = manager.getRepository(Subscription).create({
      company: { id: companyId } as Company,
      plan: { id: planId } as Plan,
      status: "pending",
    });
    return manager.getRepository(Subscription).save(row);
  }

  async update(
    id: string,
    data: Parameters<Repository<Subscription>["update"]>[1],
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(id, data);
  }

  async delete(id: string): Promise<void> {
    await this.getRepo().delete(id);
  }

  /** The owning company of a PayPal subscription id, from our own row. */
  async findCompanyIdByPaypalId(paypalSubscriptionId: string): Promise<string | undefined> {
    const [local] = (await AppDataSource.query(
      `SELECT "company_id" FROM "subscriptions" WHERE "paypal_subscription_id" = $1`,
      [paypalSubscriptionId],
    )) as { company_id: string }[];
    return local?.company_id;
  }

  /** Locks the one subscription row for a PayPal id. No join; see the class comment. */
  async lockByPaypalId(
    paypalSubscriptionId: string,
    manager: EntityManager,
  ): Promise<LockedSubscriptionRow | undefined> {
    return returningRows<LockedSubscriptionRow>(
      await manager.query(
        `SELECT "id", "company_id", "status", "last_event_at"
             FROM "subscriptions"
            WHERE "paypal_subscription_id" = $1
            FOR UPDATE`,
        [paypalSubscriptionId],
      ),
    )[0];
  }

  /**
   * Maps PayPal's plan onto our row through `plans.paypal_plan_id`. When several plan
   * versions share one PayPal plan, the one already stored wins, otherwise the newest.
   * No match leaves the row alone.
   */
  async syncPlanFromPaypal(
    subscriptionId: string,
    paypalPlanId: string,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      // The stored plan is read through its own scalar subquery. An earlier version
      // referenced a sibling FROM item from inside `m`, which Postgres rejects
      // ("missing FROM-clause entry") — caught by EXPLAIN against the real schema.
      `UPDATE "subscriptions" s
              SET "plan_id" = m."id"
             FROM (SELECT p."id" FROM "plans" p
                    WHERE p."paypal_plan_id" = $2
                    ORDER BY (p."id" = (SELECT s0."plan_id" FROM "subscriptions" s0
                                         WHERE s0."id" = $1)) DESC,
                             p."created_at" DESC
                    LIMIT 1) m
            WHERE s."id" = $1 AND s."plan_id" IS DISTINCT FROM m."id"`,
      [subscriptionId, paypalPlanId],
    );
  }

  /**
   * Locks the subscription (only — `FOR UPDATE OF s`) and reads the company's trial end
   * alongside it, for crediting one recurring payment.
   */
  async lockForCycleCredit(
    paypalSubscriptionId: string,
    manager: EntityManager,
  ): Promise<LockedCycleRow | undefined> {
    return returningRows<LockedCycleRow>(
      await manager.query(
        `SELECT s."id", s."company_id", s."plan_id", c."trial_ends_at"
             FROM "subscriptions" s
             JOIN "companies" c ON c."id" = s."company_id"
            WHERE s."paypal_subscription_id" = $1
            FOR UPDATE OF s`,
        [paypalSubscriptionId],
      ),
    )[0];
  }

  /**
   * The plan a recurring sale most plausibly paid for. Candidates: the plan PayPal
   * reports, the stored plan, and the plan of the last cycle credited. A price match
   * wins; otherwise PayPal's plan, then the stored one.
   */
  async findCyclePlan(
    params: {
      remotePlanId: string | null;
      storedPlanId: string;
      subscriptionId: string;
      amount: string;
      currency: string;
    },
    manager: EntityManager,
  ): Promise<CyclePlanRow | undefined> {
    return returningRows<CyclePlanRow>(
      await manager.query(
        `SELECT p."id", p."duration_days", p."price", p."currency"
             FROM "plans" p
            WHERE p."id" = $2
               OR ($1::varchar IS NOT NULL AND p."paypal_plan_id" = $1::varchar)
               OR p."id" = (SELECT "plan_id" FROM "payments"
                             WHERE "subscription_id" = $3 AND "kind" = 'subscription_cycle'
                             ORDER BY "created_at" DESC LIMIT 1)
            ORDER BY (p."price" = $4::numeric AND p."currency" = $5) DESC,
                     COALESCE(p."paypal_plan_id" = $1::varchar, false) DESC,
                     (p."id" = $2) DESC,
                     p."created_at" DESC
            LIMIT 1`,
        [
          params.remotePlanId,
          params.storedPlanId,
          params.subscriptionId,
          params.amount,
          params.currency,
        ],
      ),
    )[0];
  }

  /** The owner to tell about a failed renewal, with the subscription's current status. */
  async findRenewalFailedContact(
    paypalSubscriptionId: string,
  ): Promise<RenewalFailedRow | undefined> {
    const rows = (await AppDataSource.query(
      `SELECT s."id" AS "subscription_id", s."status",
                c."name" AS "company_name", c."subscription_expires_at",
                u."email", u."is_active" AS "user_active"
           FROM "subscriptions" s
           JOIN "companies" c ON c."id" = s."company_id"
           JOIN "users" u ON u."id" = c."owner_user_id"
          WHERE s."paypal_subscription_id" = $1`,
      [paypalSubscriptionId],
    )) as RenewalFailedRow[];
    return rows[0];
  }
}
