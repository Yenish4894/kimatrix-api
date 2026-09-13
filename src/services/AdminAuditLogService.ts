import { AuditLogRepository } from "@/repositories/AuditLogRepository";
import type { AuditLogQueryInput } from "@/validation/schemas/admin.schema";

export interface AuditLogItem {
  id: string;
  createdAt: Date;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** The admin audit trail. Filtering rules are documented on AuditLogRepository.listForAdmin. */
export class AdminAuditLogService {
  constructor(private readonly auditLogRepository = new AuditLogRepository()) {}

  async listAuditLog(q: AuditLogQueryInput): Promise<{ items: AuditLogItem[]; total: number }> {
    const { total, rows } = await this.auditLogRepository.listForAdmin(q);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        actorEmail: r.actor_email,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        note: r.note ?? null,
        before: r.before ?? null,
        after: r.after ?? null,
      })),
    };
  }
}
