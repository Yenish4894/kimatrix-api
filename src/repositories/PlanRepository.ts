import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { Plan } from "@/entities/Plan";

/**
 * The fields a plan update is allowed to touch, stated explicitly rather than as
 * `Partial<Plan>` — that pulls in relation arrays TypeORM's update() cannot accept,
 * and it hides which columns are genuinely mutable.
 */
export interface PlanPatch {
  name?: string;
  description?: string | null;
  durationDays?: number;
  price?: string;
  currency?: string;
  isActive?: boolean;
  isPopular?: boolean;
  sortOrder?: number;
  archivedAt?: Date | null;
  supersedes?: { id: string } | null;
  supersededBy?: { id: string } | null;
}

export class PlanRepository {
  private getRepo(manager?: EntityManager): Repository<Plan> {
    return manager ? manager.getRepository(Plan) : AppDataSource.getRepository(Plan);
  }

  /** Purchasable plans, in the order the billing page should render them. */
  async findAllActive(manager?: EntityManager): Promise<Plan[]> {
    return this.getRepo(manager).find({
      where: { isActive: true },
      order: { sortOrder: "ASC", durationDays: "ASC" },
    });
  }

  /**
   * Every plan including archived ones — admin view only.
   *
   * Loads the supersede relations explicitly: they are not eager, and without this the
   * DTO's `supersededByPlanId` / `supersedesPlanId` silently serialise as null for
   * every plan, because `plan.supersededBy?.id` on an unloaded relation is undefined.
   */
  async findAllForAdmin(manager?: EntityManager): Promise<Plan[]> {
    return this.getRepo(manager).find({
      relations: { supersedes: true, supersededBy: true },
      order: { archivedAt: "ASC", sortOrder: "ASC", durationDays: "ASC" },
    });
  }

  /**
   * Admin list plus usage flags, as ONE query.
   *
   * The previous shape issued two `SELECT`s per plan inside a `Promise.all` — 21
   * queries for ten plans, against a pool capped at 10.
   */
  async findAllForAdminWithUsage(
    manager?: EntityManager,
  ): Promise<(Plan & { hasPayments: boolean; hasSubscribers: boolean })[]> {
    const plans = await this.findAllForAdmin(manager);
    if (plans.length === 0) return [];

    const rows: { plan_id: string; has_payments: boolean; has_subscribers: boolean }[] =
      await this.getRepo(manager).manager.query(
        `SELECT p."id" AS plan_id,
                EXISTS (SELECT 1 FROM "payments" pay
                         WHERE pay."plan_id" = p."id" AND pay."deleted_at" IS NULL) AS has_payments,
                EXISTS (SELECT 1 FROM "companies" c
                         WHERE c."current_plan_id" = p."id" AND c."deleted_at" IS NULL) AS has_subscribers
           FROM "plans" p
          WHERE p."id" = ANY($1::uuid[])`,
        [plans.map((p) => p.id)],
      );

    const usage = new Map(rows.map((r) => [r.plan_id, r]));
    return plans.map((plan) =>
      Object.assign(plan, {
        hasPayments: usage.get(plan.id)?.has_payments ?? false,
        hasSubscribers: usage.get(plan.id)?.has_subscribers ?? false,
      }),
    );
  }

  /**
   * Purchase-time lookup: active plans only, so a disabled or superseded plan can
   * never be bought even if a stale plan id is submitted.
   */
  async findById(id: string, manager?: EntityManager): Promise<Plan | null> {
    return this.getRepo(manager).findOne({ where: { id, isActive: true } });
  }

  /**
   * Lookup regardless of state. Needed to render historical payments and to let the
   * admin act on a plan they have already disabled.
   */
  async findByIdAnyState(id: string, manager?: EntityManager): Promise<Plan | null> {
    return this.getRepo(manager).findOne({
      where: { id },
      relations: { supersedes: true, supersededBy: true },
    });
  }

  /**
   * Same, but takes a row lock. Used by the edit path so two concurrent price changes
   * can't each archive the same predecessor and leave two live successors behind.
   */
  async findByIdForUpdate(id: string, manager: EntityManager): Promise<Plan | null> {
    return manager
      .getRepository(Plan)
      .createQueryBuilder("p")
      .setLock("pessimistic_write")
      .where("p.id = :id", { id })
      .getOne();
  }

  /** Rows are locked so the "last active plan" guard can't be defeated by a race. */
  async countActiveForUpdate(manager: EntityManager): Promise<number> {
    const rows = await manager
      .getRepository(Plan)
      .createQueryBuilder("p")
      .where("p.is_active = true")
      .andWhere("p.deleted_at IS NULL")
      .setLock("pessimistic_write")
      .getMany();
    return rows.length;
  }

  async create(data: Partial<Plan>, manager?: EntityManager): Promise<Plan> {
    const repo = this.getRepo(manager);
    return repo.save(repo.create(data));
  }

  async update(id: string, data: PlanPatch, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager)
      .createQueryBuilder()
      .update(Plan)
      .set(data)
      .where("id = :id", { id })
      .execute();
  }

  /**
   * True when the plan carries billing history — any payment, or any company still
   * pointing at it. This is what decides whether an edit may mutate the row in place
   * or must create a new version.
   *
   * One query, not two: `companies.current_plan_id` is written on capture and never
   * cleared, so it is effectively a subset of "has payments" and never changed the
   * answer on its own. Both sides filter `deleted_at` — the payments side previously
   * did not, so a soft-deleted payment made a plan permanently un-editable.
   */
  async carriesHistory(id: string, manager?: EntityManager): Promise<boolean> {
    const rows: { carries: boolean }[] = await this.getRepo(manager).manager.query(
      `SELECT (
         EXISTS (SELECT 1 FROM "payments"  WHERE "plan_id" = $1 AND "deleted_at" IS NULL)
         OR
         EXISTS (SELECT 1 FROM "companies" WHERE "current_plan_id" = $1 AND "deleted_at" IS NULL)
       ) AS carries`,
      [id],
    );
    return rows[0]?.carries ?? false;
  }
}
