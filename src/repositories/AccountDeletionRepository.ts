import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { Company } from "@/entities/Company";
import { returningRows } from "@/utils/db";

/**
 * The account-closure writes: requesting, cancelling and executing a deletion.
 * See AccountDeletionService for what is erased, what is kept, and why.
 */
export class AccountDeletionRepository {
  async markRequested(companyId: string, userId: string, requestedAt: Date): Promise<void> {
    await AppDataSource.getRepository(Company).update(companyId, {
      deletionRequestedAt: requestedAt,
      deletionRequestedBy: { id: userId } as never,
    });
  }

  /** Clears a pending request. Returns the number of rows changed (0 = nothing pending). */
  async cancelRequest(companyId: string): Promise<number> {
    const result = await AppDataSource.getRepository(Company)
      .createQueryBuilder()
      .update(Company)
      .set({ deletionRequestedAt: null, deletionRequestedBy: null })
      .where("id = :id", { id: companyId })
      .andWhere("deletion_requested_at IS NOT NULL")
      .andWhere("anonymized_at IS NULL")
      .execute();
    return result.affected ?? 0;
  }

  /** Locks the company row for the purge's re-check. */
  async lockForPurge(
    companyId: string,
    manager: EntityManager,
  ): Promise<
    { id: string; deletion_requested_at: Date | null; anonymized_at: Date | null } | undefined
  > {
    return returningRows<{
      id: string;
      deletion_requested_at: Date | null;
      anonymized_at: Date | null;
    }>(
      await manager.query(
        `SELECT "id", "deletion_requested_at", "anonymized_at"
             FROM "companies" WHERE "id" = $1 FOR UPDATE`,
        [companyId],
      ),
    )[0];
  }

  /**
   * Scrubs the company row. `qr_token` is randomised rather than nulled so the column's
   * NOT NULL + UNIQUE hold and any printed QR code stops resolving to anything.
   */
  async anonymizeCompany(companyId: string, manager: EntityManager): Promise<void> {
    await manager.query(
      `UPDATE "companies"
            SET "name" = 'Closed account',
                "street_address" = '', "city" = '', "state" = '', "postal_code" = NULL,
                "registration_number" = 'DELETED-' || "id",
                "contact_email" = 'deleted@invalid',
                "contact_phone" = '',
                "whatsapp_number" = NULL,
                "qr_token" = 'deleted-' || replace("id"::text, '-', ''),
                "is_active" = false,
                "subscription_status" = 'deactivated',
                "deactivated_at" = COALESCE("deactivated_at", now()),
                "anonymized_at" = now()
          WHERE "id" = $1`,
      [companyId],
    );
  }

  /**
   * Scrubs the owner. The password is set to a value bcrypt can never produce, so the
   * account cannot be logged into even if a hash were somehow guessed. Returns the ids
   * of the scrubbed users.
   */
  async scrubOwner(companyId: string, manager: EntityManager): Promise<{ id: string }[]> {
    return returningRows<{ id: string }>(
      await manager.query(
        `UPDATE "users" u
              SET "email" = 'deleted+' || u."id" || '@invalid',
                  "username" = 'deleted_' || replace(u."id"::text, '-', ''),
                  "password" = 'ACCOUNT_DELETED',
                  "is_active" = false,
                  "email_verified_at" = NULL
             FROM "companies" c
            WHERE c."id" = $1 AND u."id" = c."owner_user_id"
        RETURNING u."id"`,
        [companyId],
      ),
    );
  }

  /** Companies whose deletion was requested on or before `cutoff` and not yet purged. */
  async findDue(cutoff: Date): Promise<string[]> {
    const rows = (await AppDataSource.query(
      `SELECT "id" FROM "companies"
        WHERE "deletion_requested_at" IS NOT NULL
          AND "deletion_requested_at" <= $1
          AND "anonymized_at" IS NULL`,
      [cutoff],
    )) as { id: string }[];
    return rows.map((r) => r.id);
  }
}
