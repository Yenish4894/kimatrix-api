import { AppDataSource } from "data-source";
import { EXPIRY_RETENTION_DAYS } from "@/config/retention";
import { CustomerDataErasureRepository } from "@/repositories/CustomerDataErasureRepository";
import {
  ExpiredDataPurgeRepository,
  type PurgeCandidate,
} from "@/repositories/ExpiredDataPurgeRepository";
import type { TransactionRunner } from "@/utils/db";
import { logger } from "@/utils/logger";

export type { PurgeCandidate };

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
  constructor(
    private readonly purgeRepository = new ExpiredDataPurgeRepository(),
    private readonly erasureRepository = new CustomerDataErasureRepository(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

  /**
   * Companies whose retention window has fully elapsed.
   *
   * `access_ended_at` is the later of the trial end and the paid expiry, which is the
   * same thing `computeEntitlement` treats as the end of access. Taking the later of
   * the two is what stops a company that converted mid-trial from being judged on its
   * trial date.
   */
  async findDue(now = new Date()): Promise<PurgeCandidate[]> {
    return this.purgeRepository.findDue(EXPIRY_RETENTION_DAYS, now);
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
    return this.db.transaction(async (manager) => {
      const company = await this.purgeRepository.lockCompany(companyId, manager);
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

      // The lucky-draw history keeps its winner snapshot: the account lives on, and a
      // prize dispute can still be raised about a draw it ran.
      const erased = await this.erasureRepository.eraseCompanyCustomerData(manager, companyId, {
        scrubDrawWinners: false,
      });

      // The account itself is untouched. They can log in, subscribe, and start again.
      await this.purgeRepository.markPurged(companyId, now, manager);

      const result: ExpiredPurgeResult = {
        companyId,
        name: company.name,
        ...erased,
      };
      logger.warn(
        { ...result, retentionDays: EXPIRY_RETENTION_DAYS },
        "Expired company data erased — account and payment history retained",
      );
      return result;
    });
  }
}
