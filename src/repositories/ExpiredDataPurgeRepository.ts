import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";

export interface PurgeCandidate {
  id: string;
  name: string;
  owner_email: string;
  access_ended_at: Date;
  days_expired: number;
  customers: number;
  purchases: number;
}

/** The company row as the purge re-checks it under lock. */
export interface LockedPurgeCompany {
  id: string;
  name: string;
  data_purged_at: Date | null;
  anonymized_at: Date | null;
  is_comped: boolean;
  access_ended_at: Date;
}

/**
 * Reads and writes for the expired-data purge. See ExpiredDataPurgeService for the
 * policy; every condition in `findDue` is a guard, not a filter.
 */
export class ExpiredDataPurgeRepository {
  /**
   * Companies whose retention window has fully elapsed. `access_ended_at` is the later
   * of the trial end and the paid expiry. $1 = retention days, $2 = now.
   */
  async findDue(retentionDays: number, now: Date): Promise<PurgeCandidate[]> {
    return (await AppDataSource.manager.query(
      `SELECT c."id",
              c."name",
              u."email" AS owner_email,
              GREATEST(
                COALESCE(c."trial_ends_at",            'epoch'::timestamptz),
                COALESCE(c."subscription_expires_at",  'epoch'::timestamptz)
              ) AS access_ended_at,
              EXTRACT(DAY FROM $2::timestamptz - GREATEST(
                COALESCE(c."trial_ends_at",           'epoch'::timestamptz),
                COALESCE(c."subscription_expires_at", 'epoch'::timestamptz)
              ))::int AS days_expired,
              (SELECT count(*) FROM "customers" x
                WHERE x."company_id" = c."id" AND x."deleted_at" IS NULL)::int AS customers,
              (SELECT count(*) FROM "purchases" p
                WHERE p."company_id" = c."id" AND p."deleted_at" IS NULL)::int AS purchases
         FROM "companies" c
         JOIN "users" u ON u."id" = c."owner_user_id"
        WHERE c."deleted_at" IS NULL
          -- Never collected, or already erased: nothing to do either way.
          AND c."data_purged_at" IS NULL
          AND c."anonymized_at" IS NULL
          -- An admin comp is an explicit decision to keep them running.
          AND c."is_comped" = false
          -- Must have actually had access at some point. A company that registered and
          -- never started a trial has no expiry date to count from.
          AND (c."trial_ends_at" IS NOT NULL OR c."subscription_expires_at" IS NOT NULL)
          -- The window, measured from whichever access ended last.
          AND GREATEST(
                COALESCE(c."trial_ends_at",           'epoch'::timestamptz),
                COALESCE(c."subscription_expires_at", 'epoch'::timestamptz)
              ) <= $2::timestamptz - make_interval(days => $1::int)
        ORDER BY access_ended_at`,
      [retentionDays, now],
    )) as PurgeCandidate[];
  }

  /** Locks the company row so the deadline can be re-checked before erasing. */
  async lockCompany(
    companyId: string,
    manager: EntityManager,
  ): Promise<LockedPurgeCompany | undefined> {
    const locked = (await manager.query(
      `SELECT c."id", c."name", c."data_purged_at", c."anonymized_at", c."is_comped",
                GREATEST(
                  COALESCE(c."trial_ends_at",           'epoch'::timestamptz),
                  COALESCE(c."subscription_expires_at", 'epoch'::timestamptz)
                ) AS access_ended_at
           FROM "companies" c
          WHERE c."id" = $1 AND c."deleted_at" IS NULL
            FOR UPDATE`,
      [companyId],
    )) as LockedPurgeCompany[];
    return locked[0];
  }

  async markPurged(companyId: string, purgedAt: Date, manager: EntityManager): Promise<void> {
    await manager.query(`UPDATE "companies" SET "data_purged_at" = $2 WHERE "id" = $1`, [
      companyId,
      purgedAt,
    ]);
  }
}
