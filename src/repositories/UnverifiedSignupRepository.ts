import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { affectedRows } from "@/utils/db";

/**
 * Finds and removes self-service signups whose owner never confirmed their email.
 *
 * Why remove them at all: an unverified signup is, overwhelmingly, a typo'd or fake
 * address — the kind whose bounces got the SMTP mailbox suspended. Left in place it
 * keeps the address (and username, and registration number) locked against the real
 * owner, and sits in every admin list and bulk-email audience.
 *
 * Why a HARD delete rather than `AccountDeletionService.purgeCompany`: that purge does
 * free the email (it rewrites it to `deleted+<id>@invalid`), but it is the wrong tool.
 * It refuses to run without a customer's deletion request, and it deliberately leaves
 * a "Closed account" row behind — marked deactivated — because it exists to keep a
 * paying customer's money ledger. A never-verified signup has no ledger (the predicate
 * guarantees it), so a tombstone would only pollute admin lists and ban counts with
 * accounts nobody closed. Nothing of value is lost by deleting outright.
 *
 * Every SQL statement is an exported constant so it can be read, tested and EXPLAINed
 * on its own. Parameters are positional and documented on each.
 */

/** Days a signup gets to click the link before it counts as abandoned. */
export const UNVERIFIED_MIN_AGE_DAYS = 7;
/**
 * A `pending` payment or subscription older than this is an abandoned PayPal approval,
 * not one in flight. Far longer than any real approval takes, and the company itself is
 * already a week old, so this never races a live checkout.
 */
export const ABANDONED_PENDING_HOURS = 24;
/**
 * `admin_audit_log.actor_email` is NOT NULL and `actor_user_id` nullable, so a system
 * row carries this marker and no user — the same convention PaypalWebhookService uses.
 */
export const UNVERIFIED_CLEANUP_ACTOR = "system:unverified-cleanup";

/**
 * Payment rows that never moved money. `capturing` is NOT here: it means money may have
 * moved and we never heard back, so such a company is never touched. Uses $2 (hours).
 */
const paymentMovedNoMoney = (p: string): string =>
  `(${p}."status" = 'failed' OR (${p}."status" = 'pending' AND ${p}."created_at" < now() - make_interval(hours => $2::int)))`;

/** A subscription created at PayPal and never approved. Uses $2 (hours). */
const subscriptionNeverApproved = (s: string): string =>
  `(${s}."status" = 'pending' AND ${s}."created_at" < now() - make_interval(hours => $2::int))`;

/**
 * The single definition of "an abandoned, unverified signup", shared by the candidate
 * query and the locked re-check so the two can never drift apart.
 *
 * Aliases: c = companies, u = users. Parameters: $1 = min age in days, $2 = abandoned-
 * pending hours.
 *
 * Soft-deleted payments/customers/purchases are deliberately NOT filtered out of the
 * NOT EXISTS checks: any trace of money or customer data, deleted or not, is a reason
 * to leave the account for a human.
 */
export const UNVERIFIED_SIGNUP_PREDICATE = `
      u."user_type" = 'company'
  AND u."email_verified_at" IS NULL
  AND u."deleted_at" IS NULL
  AND c."deleted_at" IS NULL
  AND c."created_at" < now() - make_interval(days => $1::int)
  AND c."is_comped" = false
  AND (c."trial_ends_at" IS NULL OR c."trial_ends_at" <= now())
  AND c."subscription_expires_at" IS NULL
  AND c."deactivated_at" IS NULL
  AND c."anonymized_at" IS NULL
  AND c."deletion_requested_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "payments" p
                   WHERE p."company_id" = c."id" AND NOT ${paymentMovedNoMoney("p")})
  AND NOT EXISTS (SELECT 1 FROM "subscriptions" s
                   WHERE s."company_id" = c."id" AND NOT ${subscriptionNeverApproved("s")})
  AND NOT EXISTS (SELECT 1 FROM "customers" cu WHERE cu."company_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "purchases" pu WHERE pu."company_id" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "admin_audit_log" a
                   WHERE a."entity_type" = 'company'
                     AND a."entity_id" = c."id"::text
                     AND a."action" = 'company.create')`;

/**
 * Candidates, oldest first. $1 = min age days, $2 = abandoned hours, $3 = row limit.
 * Returns the email DOMAIN only — the dry-run log must never carry a full address.
 */
export const UNVERIFIED_CANDIDATES_SQL = `
SELECT c."id"         AS "company_id",
       c."created_at" AS "created_at",
       u."id"         AS "owner_user_id",
       lower(split_part(u."email", '@', 2)) AS "email_domain"
  FROM "companies" c
  JOIN "users" u ON u."id" = c."owner_user_id"
 WHERE ${UNVERIFIED_SIGNUP_PREDICATE}
 ORDER BY c."created_at"
 LIMIT $3`;

/**
 * Re-checks one candidate under row locks at the moment of deletion.
 * $1 = min age days, $2 = abandoned hours, $3 = company id.
 *
 * The lock on `u` is what makes a concurrent email verification safe: whichever of the
 * two gets the row first wins, and if the verify commits first, Postgres re-evaluates
 * `email_verified_at IS NULL` against the new row and this returns nothing.
 */
export const LOCK_UNVERIFIED_CANDIDATE_SQL = `
SELECT c."id"         AS "company_id",
       c."name"       AS "name",
       c."created_at" AS "created_at",
       u."id"         AS "owner_user_id",
       lower(split_part(u."email", '@', 2))         AS "email_domain",
       lower(split_part(c."contact_email", '@', 2)) AS "contact_email_domain"
  FROM "companies" c
  JOIN "users" u ON u."id" = c."owner_user_id"
 WHERE c."id" = $3
   AND ${UNVERIFIED_SIGNUP_PREDICATE}
   FOR UPDATE OF c, u`;

/**
 * The deletion, in FK order. $1 = company id (owner user id for the last one), $2 =
 * abandoned hours.
 *
 * The payment/subscription deletes carry the SAME no-money filter as the predicate
 * rather than deleting everything for the company. So if a real payment lands between
 * the check and the delete, it survives, its ON DELETE RESTRICT foreign key makes the
 * company delete fail, and the whole transaction rolls back. The same RESTRICT keys on
 * customers and purchases are the backstop for those — they are never deleted here.
 */
export const DELETE_ABANDONED_PAYMENTS_SQL = `
DELETE FROM "payments" p
 WHERE p."company_id" = $1
   AND ${paymentMovedNoMoney("p")}`;

export const DELETE_ABANDONED_SUBSCRIPTIONS_SQL = `
DELETE FROM "subscriptions" s
 WHERE s."company_id" = $1
   AND ${subscriptionNeverApproved("s")}`;

/**
 * FK effects, all intended: trial_identities.company_id → SET NULL (the ledger entry
 * outlives the company, so deleting cannot mint a fresh trial — though an unverified
 * owner never claimed one); lucky_draws → CASCADE (impossible here: a draw needs a
 * customer); current_subscription_id was already cleared by the subscription delete.
 */
export const DELETE_COMPANY_SQL = `DELETE FROM "companies" WHERE "id" = $1`;

/**
 * FK effects: tokens and email_change_tokens → CASCADE, so no refresh, reset or
 * verification token can outlive the account; every other user reference (audit
 * actor, comp/ban/release-by) is SET NULL. The `email_verified_at IS NULL` guard is
 * belt-and-braces on top of the row lock.
 */
export const DELETE_OWNER_USER_SQL = `DELETE FROM "users" WHERE "id" = $1 AND "email_verified_at" IS NULL`;

/**
 * $1 = actor marker, $2 = company id, $3 = before (json), $4 = note.
 * `entity_id` is not an FK, so this row outlives the company it describes.
 */
export const INSERT_CLEANUP_AUDIT_SQL = `
INSERT INTO "admin_audit_log"
       ("actor_user_id", "actor_email", "action", "entity_type", "entity_id", "before", "after", "note")
VALUES (NULL, $1, 'company.unverified_cleanup', 'company', $2, $3, NULL, $4)`;

export interface UnverifiedCandidate {
  company_id: string;
  created_at: Date;
  owner_user_id: string;
  email_domain: string;
}

interface LockedCandidate extends UnverifiedCandidate {
  name: string;
  contact_email_domain: string;
}

export interface RemovedSignup {
  companyId: string;
  createdAt: Date;
  emailDomain: string;
  paymentsDeleted: number;
  subscriptionsDeleted: number;
}

export class UnverifiedSignupRepository {
  async findCandidates(limit: number, manager?: EntityManager): Promise<UnverifiedCandidate[]> {
    const runner = manager ?? AppDataSource.manager;
    return (await runner.query(UNVERIFIED_CANDIDATES_SQL, [
      UNVERIFIED_MIN_AGE_DAYS,
      ABANDONED_PENDING_HOURS,
      limit,
    ])) as UnverifiedCandidate[];
  }

  /**
   * Removes one signup in its own transaction. Returns null, touching nothing, if it
   * stopped qualifying since the candidate list was read (it verified, paid, got a
   * customer, was comped...). Throws — rolling everything back — if any delete does not
   * behave exactly as expected.
   */
  async removeCandidate(companyId: string): Promise<RemovedSignup | null> {
    return AppDataSource.transaction(async (manager) => {
      const [locked] = (await manager.query(LOCK_UNVERIFIED_CANDIDATE_SQL, [
        UNVERIFIED_MIN_AGE_DAYS,
        ABANDONED_PENDING_HOURS,
        companyId,
      ])) as LockedCandidate[];
      if (!locked) return null;

      const paymentsDeleted = affectedRows(
        await manager.query(DELETE_ABANDONED_PAYMENTS_SQL, [companyId, ABANDONED_PENDING_HOURS]),
      );
      const subscriptionsDeleted = affectedRows(
        await manager.query(DELETE_ABANDONED_SUBSCRIPTIONS_SQL, [
          companyId,
          ABANDONED_PENDING_HOURS,
        ]),
      );

      const companies = affectedRows(await manager.query(DELETE_COMPANY_SQL, [companyId]));
      if (companies !== 1) throw new Error(`Expected to delete 1 company, deleted ${companies}`);

      const users = affectedRows(
        await manager.query(DELETE_OWNER_USER_SQL, [locked.owner_user_id]),
      );
      if (users !== 1) throw new Error(`Expected to delete 1 owner user, deleted ${users}`);

      // Domains, not addresses: the point of the removal is that we stop holding an
      // address nobody proved they own, so the trail must not keep a copy of it.
      await manager.query(INSERT_CLEANUP_AUDIT_SQL, [
        UNVERIFIED_CLEANUP_ACTOR,
        companyId,
        JSON.stringify({
          name: locked.name,
          createdAt: new Date(locked.created_at).toISOString(),
          ownerEmailDomain: locked.email_domain,
          contactEmailDomain: locked.contact_email_domain,
          paymentsDeleted,
          subscriptionsDeleted,
        }),
        `Owner never verified their email within ${UNVERIFIED_MIN_AGE_DAYS} days; no payments, customers, comp or trial.`,
      ]);

      return {
        companyId,
        createdAt: locked.created_at,
        emailDomain: locked.email_domain,
        paymentsDeleted,
        subscriptionsDeleted,
      };
    });
  }
}
