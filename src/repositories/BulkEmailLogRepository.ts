import { AppDataSource } from "data-source";
import { BulkEmailLog } from "@/entities/BulkEmailLog";

export class BulkEmailLogRepository {
  async create(data: Partial<BulkEmailLog>): Promise<BulkEmailLog> {
    const repo = AppDataSource.getRepository(BulkEmailLog);
    const log = repo.create(data);
    return repo.save(log);
  }

  async list(page: number, limit: number): Promise<{ items: BulkEmailLog[]; total: number }> {
    const repo = AppDataSource.getRepository(BulkEmailLog);
    const [items, total] = await repo.findAndCount({
      order: { sentAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }
}
