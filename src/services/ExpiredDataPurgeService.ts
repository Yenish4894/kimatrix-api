import { AppDataSource } from "data-source";
import { EXPIRY_RETENTION_DAYS } from "@/config/retention";
import { affectedRows } from "@/utils/db";
import { logger } from "@/utils/logger";

export interface PurgeCandidate {
  id: string;
  name: string;
  owner_email: string;
  access_ended_at: Date;
  days_expired: number;
  customers: number;
  purchases: number;
}

export interface ExpiredPurgeResult {
  companyId: string;
  name: string;
  customersDeleted: number;
  purchasesDeleted: number;
}

/**
 * Erases the customer data of companies that lapsed and never came back.
 *
 * Deliberately NOT the same operation as a voluntary account closure. A company that
 * stopped paying has not left: its account, login, identity and payment history all
 * survive, so it can return, subscribe, and start collecting again. Only the third-party
 * personal data it gathered — customers and their purchases — is removed, because that
 * is what we told the customer would happen and what we have no basis to keep once the
 * relationship has lapsed.
 *
 * This is the only irreversible operation in the platform, so every condition below is
 * a guard rather than a filter, and `findDue` is exposed separately so the exact set
 * can be inspected before anything is deleted.
 */
export class ExpiredDataPurgeService {
  /**
   * Companies whose retention window has fully elapsed.
   *
   * `access_ended_at` is the later of the trial end and the paid expiry, which is the
   * same thing `computeEntitlement` treats as the end of access. Taking the later of
   * the two is what stops a company that converted mid-trial from being judged on its
   * trial date.
   */
  async findDue(now = new Date()): Promise<PurgeCandidate[]> {
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
      [EXPIRY_RETENTION_DAYS, now],
    )) as PurgeCandidate[];
  }

  /**
   * Erase one company's collected data.
   *
   * Re-checks the deadline inside the transaction with the row locked. The candidate
   * list is read before the loop starts, and a company that renews in between must not
   * be erased on the strength of a check made seconds earlier — that is the failure
   * this whole design exists to avoid.
   */
  async purge(companyId: string, now = new Date()): Promise<ExpiredPurgeResult | null> {
    return AppDataSource.transaction(async (manager) => {
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
      )) as {
        id: string;
        name: string;
        data_purged_at: Date | null;
        anonymized_at: Date | null;
        is_comped: boolean;
        access_ended_at: Date;
      }[];

      const company = locked[0];
      if (!company) return null;

      const cutoff = new Date(now.getTime() - EXPIRY_RETENTION_DAYS * 86_400_000);
      const stillEligible =
        !company.data_purged_at &&
        !company.anonymized_at &&
        !company.is_comped &&
        new Date(company.access_ended_at).getTime() <= cutoff.getTime();

      if (!stillEligible) {
        logger.info({ companyId }, "Expiry purge skipped — no longer eligible when locked");
        return null;
      }

      // Purchases first: they reference customers with ON DELETE RESTRICT.
      const purchases = await manager.query(`DELETE FROM "purchases" WHERE "company_id" = $1`, [
        companyId,
      ]);
      const customers = await manager.query(`DELETE FROM "customers" WHERE "company_id" = $1`, [
        companyId,
      ]);

      // The account itself is untouched. They can log in, subscribe, and start again.
      await manager.query(`UPDATE "companies" SET "data_purged_at" = $2 WHERE "id" = $1`, [
        companyId,
        now,
      ]);

      const result: ExpiredPurgeResult = {
        companyId,
        name: company.name,
        purchasesDeleted: affectedRows(purchases),
        customersDeleted: affectedRows(customers),
      };
      logger.warn(
        { ...result, retentionDays: EXPIRY_RETENTION_DAYS },
        "Expired company data erased — account and payment history retained",
      );
      return result;
    });
  }
}
