import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { SubscriptionService } from "@/services/SubscriptionService";
import { AccountDeletionRepository } from "@/repositories/AccountDeletionRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { CustomerDataErasureRepository } from "@/repositories/CustomerDataErasureRepository";
import { TokenRepository } from "@/repositories/TokenRepository";
import { BadRequestError, NotFoundError } from "@/errors/index";
import type { TransactionRunner } from "@/utils/db";
import { logger } from "@/utils/logger";

/** How long a request sits before it is acted on. */
export const DELETION_GRACE_DAYS = 30;

export interface DeletionStatus {
  requested: boolean;
  requestedAt: Date | null;
  /** When the data will actually be erased. Null when nothing is pending. */
  purgeAt: Date | null;
  daysRemaining: number | null;
}

export interface PurgeResult {
  companyId: string;
  purchasesDeleted: number;
  customersDeleted: number;
}

export class AccountDeletionService {
  constructor(
    private readonly subscriptionService = new SubscriptionService(),
    private readonly tokenRepository = new TokenRepository(),
    private readonly companyRepository = new CompanyRepository(),
    private readonly deletionRepository = new AccountDeletionRepository(),
    private readonly erasureRepository = new CustomerDataErasureRepository(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

  /**
   * Records a deletion request and stops any further billing immediately.
   *
   * The subscription is cancelled at once rather than at purge time: somebody who has
   * asked to leave must not be charged again while the grace period runs. Their access
   * still runs to the end of the period they paid for — `subscription_expires_at` is
   * untouched — so they keep working and can still export right up until the purge.
   */
  async requestDeletion(companyId: string, userId: string): Promise<DeletionStatus> {
    const company = await this.companyRepository.findById(companyId);
    if (!company) throw NotFoundError("Company not found");
    if (company.anonymizedAt) throw BadRequestError("This account has already been closed.");
    if (company.deletionRequestedAt) return this.toStatus(company.deletionRequestedAt);

    // Best effort. A PayPal outage must not stop someone from requesting deletion —
    // the purge itself cancels again before erasing anything.
    await this.subscriptionService.cancelForAdmin(companyId).catch((err: unknown) => {
      logger.error({ err, companyId }, "Could not cancel subscription on deletion request");
    });

    const now = new Date();
    await this.deletionRepository.markRequested(companyId, userId, now);

    logger.warn({ companyId, userId, purgeAt: this.purgeAt(now) }, "Account deletion requested");
    return this.toStatus(now);
  }

  /**
   * Cancels a pending request.
   *
   * Possible right up until the purge runs, which is most of the point of the grace
   * period. The subscription is NOT resurrected — PayPal cancellation is terminal — so
   * the customer has to resubscribe, and the UI says so.
   */
  async cancelDeletion(companyId: string): Promise<void> {
    const affected = await this.deletionRepository.cancelRequest(companyId);

    if (affected === 0) {
      throw NotFoundError("There is no pending deletion request for this account.");
    }
    logger.info({ companyId }, "Account deletion request cancelled");
  }

  async getStatus(companyId: string): Promise<DeletionStatus> {
    const company = await this.companyRepository.findById(companyId);
    return this.toStatus(company?.deletionRequestedAt ?? null);
  }

  /**
   * Erases one company's personal data. Irreversible.
   *
   * Order matters and is enforced by the FK graph: `purchases` reference `customers`
   * with ON DELETE RESTRICT, so purchases go first. All of it runs in one transaction —
   * a half-erased account would be worse than either outcome, leaving customers whose
   * purchases are gone and a company that still looks live.
   *
   * `payments` and `subscriptions` are deliberately left intact. They are the money
   * ledger; erasing them would destroy the record of what we charged, which is both a
   * bookkeeping obligation and the only way to answer a later chargeback. They now
   * point at an anonymised company, which carries no personal data.
   *
   * `trial_identities` is deliberately left intact too — those rows are HMACs, not
   * personal data, and clearing them would turn account deletion into a way to earn
   * another free trial.
   */
  async purgeCompany(companyId: string): Promise<PurgeResult> {
    return this.db.transaction(async (manager) => {
      // Lock the row so a concurrent cancelDeletion cannot slip in between the check
      // and the erasure.
      const locked = await this.deletionRepository.lockForPurge(companyId, manager);
      if (!locked) throw NotFoundError("Company not found");
      if (!locked.deletion_requested_at) {
        throw BadRequestError("This account has no pending deletion request.");
      }
      if (locked.anonymized_at) {
        return { companyId, purchasesDeleted: 0, customersDeleted: 0 };
      }

      // Third-party personal data. A closed account also loses the winner names on its
      // lucky-draw history: there is no company left to raise a prize dispute.
      const erased = await this.erasureRepository.eraseCompanyCustomerData(manager, companyId, {
        scrubDrawWinners: true,
      });

      // Scrub the company. `qr_token` is randomised rather than nulled so the column's
      // NOT NULL + UNIQUE hold and any printed QR code stops resolving to anything.
      await this.deletionRepository.anonymizeCompany(companyId, manager);

      // Scrub the owner. The password is set to a value bcrypt can never produce, so
      // the account cannot be logged into even if a hash were somehow guessed.
      const ownerRows = await this.deletionRepository.scrubOwner(companyId, manager);

      // Kill every session. Without this an open tab keeps working against an account
      // that no longer exists, on an access token that stays valid until it expires.
      for (const owner of ownerRows) {
        await this.tokenRepository.revokeAllRefreshTokensForUser(owner.id, manager);
      }

      const result: PurgeResult = { companyId, ...erased };
      logger.warn(result, "Account purged — personal data erased, financial records retained");
      return result;
    });
  }

  /** Companies whose grace period has elapsed. */
  async findDue(now: Date): Promise<string[]> {
    const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);
    return this.deletionRepository.findDue(cutoff);
  }

  private purgeAt(requestedAt: Date): Date {
    return new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000);
  }

  private toStatus(requestedAt: Date | null): DeletionStatus {
    if (!requestedAt) {
      return { requested: false, requestedAt: null, purgeAt: null, daysRemaining: null };
    }
    const purgeAt = this.purgeAt(requestedAt);
    return {
      requested: true,
      requestedAt,
      purgeAt,
      daysRemaining: Math.max(0, Math.ceil((purgeAt.getTime() - Date.now()) / 86_400_000)),
    };
  }
}

export type { EntityManager };
