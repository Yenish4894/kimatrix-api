import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { AppSetting, type AppSettingKey } from "@/entities/AppSetting";

export class AppSettingRepository {
  private getRepo(manager?: EntityManager): Repository<AppSetting> {
    return manager ? manager.getRepository(AppSetting) : AppDataSource.getRepository(AppSetting);
  }

  async findAll(manager?: EntityManager): Promise<AppSetting[]> {
    return this.getRepo(manager).find();
  }

  async findByKey(key: AppSettingKey, manager?: EntityManager): Promise<AppSetting | null> {
    return this.getRepo(manager).findOne({ where: { key } });
  }

  /**
   * Upsert on `key`. Uses ON CONFLICT rather than read-then-write so two concurrent
   * admin saves cannot race into a duplicate-key error against `uq_app_settings_key`.
   */
  async upsert(
    key: AppSettingKey,
    value: string,
    updatedByUserId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager)
      .createQueryBuilder()
      .insert()
      .into(AppSetting)
      .values({ key, value, updatedBy: updatedByUserId ? { id: updatedByUserId } : null })
      .orUpdate(["value", "updated_by_user_id", "updated_at"], ["key"])
      .execute();
  }
}
