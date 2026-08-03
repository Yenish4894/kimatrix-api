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

  /**
   * Plans that are still sellable and priced in some other currency. Non-zero means a
   * currency switch would leave the billing page showing two currencies at once.
   * Archived plans are excluded — they can't be bought, and their currency is
   * historically correct for the payments that reference them.
   */
  async countSellablePlansNotIn(currency: string, manager?: EntityManager): Promise<number> {
    const rows: { count: string }[] = await this.getRepo(manager).manager.query(
      `SELECT count(*)::text AS count FROM "plans"
        WHERE "currency" <> $1 AND "is_active" = true
          AND "archived_at" IS NULL AND "deleted_at" IS NULL`,
      [currency],
    );
    return Number.parseInt(rows[0]?.count ?? "0", 10);
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
