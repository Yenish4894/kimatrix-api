import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { AdminAuditLog, type AuditAction } from "@/entities/AdminAuditLog";
import { logger } from "@/utils/logger";

export interface AuditEntry {
  actorUserId: string;
  actorEmail: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  note?: string | null;
}

export class AuditService {
  /**
   * Writes an audit row.
   *
   * Pass the caller's `manager` so the log commits atomically with the change it
   * describes — an audit trail that can disagree with reality is worse than none.
   *
   * Failures are logged and swallowed **only** when no manager is supplied (i.e. the
   * caller is not in a transaction), so a logging problem can never roll back a
   * legitimate admin action that already succeeded.
   */
  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    const repo = manager
      ? manager.getRepository(AdminAuditLog)
      : AppDataSource.getRepository(AdminAuditLog);

    const row = repo.create({
      actor: { id: entry.actorUserId },
      actorEmail: entry.actorEmail,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      note: entry.note ?? null,
    });

    if (manager) {
      await repo.save(row);
      return;
    }

    try {
      await repo.save(row);
    } catch (err) {
      logger.error({ err, action: entry.action, entityId: entry.entityId }, "Audit write failed");
    }
  }
}
