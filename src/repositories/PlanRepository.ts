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

  /** Every plan including archived ones — admin view only. */
  async findAllForAdmin(manager?: EntityManager): Promise<Plan[]> {
    return this.getRepo(manager).find({
      order: { archivedAt: "ASC", sortOrder: "ASC", durationDays: "ASC" },
    });
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
    return this.getRepo(manager).findOne({ where: { id } });
  }

  async countActive(manager?: EntityManager): Promise<number> {
    return this.getRepo(manager).count({ where: { isActive: true } });
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

  /** True when any payment references this plan — i.e. it carries billing history. */
  async hasPayments(id: string, manager?: EntityManager): Promise<boolean> {
    const count = await this.getRepo(manager).manager.query(
      `SELECT 1 FROM "payments" WHERE "plan_id" = $1 LIMIT 1`,
      [id],
    );
    return count.length > 0;
  }

  /** True when any company currently points at this plan. */
  async hasSubscribers(id: string, manager?: EntityManager): Promise<boolean> {
    const rows = await this.getRepo(manager).manager.query(
      `SELECT 1 FROM "companies" WHERE "current_plan_id" = $1 AND "deleted_at" IS NULL LIMIT 1`,
      [id],
    );
    return rows.length > 0;
  }
}
