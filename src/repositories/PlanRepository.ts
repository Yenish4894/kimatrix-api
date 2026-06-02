import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { Plan } from "@/entities/Plan";

export class PlanRepository {
  private getRepo(manager?: EntityManager): Repository<Plan> {
    return manager ? manager.getRepository(Plan) : AppDataSource.getRepository(Plan);
  }

  async findAllActive(manager?: EntityManager): Promise<Plan[]> {
    return this.getRepo(manager).find({
      where: { isActive: true },
      order: { durationDays: "ASC" },
    });
  }

  async findById(id: string, manager?: EntityManager): Promise<Plan | null> {
    return this.getRepo(manager).findOne({ where: { id, isActive: true } });
  }
}
