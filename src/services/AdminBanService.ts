import { AppDataSource } from "data-source";
import { BadRequestError, NotFoundError } from "@/errors/index";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { TokenRepository } from "@/repositories/TokenRepository";
import { AuditService } from "@/services/AuditService";
import { SubscriptionService } from "@/services/SubscriptionService";
import type { TransactionRunner } from "@/utils/db";
import { computeEntitlement } from "@/utils/entitlement";
import { logger } from "@/utils/logger";

/** Admin bans: deactivating a company and lifting the ban. */
export class AdminBanService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly subscriptionService = new SubscriptionService(),
    private readonly tokenRepository = new TokenRepository(),
    private readonly auditService = new AuditService(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

  async deactivateCompany(
    actor: { id: string; email: string },
    companyId: string,
    reason: string,
  ): Promise<void> {
    await this.db.transaction(async (manager) => {
      const company = await this.companyRepository.findByIdWithOwner(companyId, manager);
      if (!company) {
        throw NotFoundError("Company not found");
      }
      // Guards on `deactivatedAt`, NOT on `isActive`.
      //
      // `isActive` now means "currently entitled to operate", so an expired or
      // trial-expired company already has `isActive = false`. Guarding on it meant the
      // admin was told "Company is already deactivated" and REFUSED — so the one
      // company most likely to need banning, the one sitting on the paywall abusing a
      // trial, was the one company that could not be banned.
      if (company.deactivatedAt != null) {
        throw BadRequestError("This company is already deactivated.");
      }

      // Stop billing before flipping the switch. Without this we would keep charging a
      // company we have just banned — every renewal, indefinitely, with no way for them
      // to log in and stop it.
      await this.subscriptionService.cancelForAdmin(companyId, manager);

      await this.companyRepository.setDeactivated(companyId, actor.id, reason, manager);
      await this.tokenRepository.revokeAllRefreshTokensForUser(company.owner.id, manager);

      // Audited because this is not reversible from the customer’s side: their sessions
      // are gone, they cannot log in to pay, and they cannot export. A real ban once had
      // to be reconstructed from pm2 logs days later because nothing here recorded it.
      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "company.ban",
          entityType: "company",
          entityId: companyId,
          before: { subscriptionStatus: company.subscriptionStatus, isActive: company.isActive },
          after: { subscriptionStatus: "deactivated", isActive: false },
          note: reason,
        },
        manager,
      );

      logger.info(
        { companyId, adminUserId: actor.id, ownerUserId: company.owner.id, reason },
        "Company deactivated; owner refresh tokens revoked",
      );
    });
  }

  /**
   * Lifts an admin ban. Explicitly **not** "grant access".
   *
   * The old version set `isActive = true` unconditionally, which — once `isActive`
   * meant entitlement — silently handed an expired company a working dashboard and a
   * live QR code with no payment, until the hourly cron noticed and switched it back
   * off. Now the ban is cleared and `computeEntitlement` decides what the company is
   * actually entitled to, which for an expired account is correctly nothing.
   */
  async activateCompany(
    actor: { id: string; email: string },
    companyId: string,
    reason?: string | null,
  ): Promise<{ status: string; hasAccess: boolean }> {
    return this.db.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      if (!company) {
        throw NotFoundError("Company not found");
      }
      if (company.deactivatedAt == null) {
        throw BadRequestError("This company is not deactivated.");
      }

      await this.companyRepository.clearDeactivation(companyId, manager);

      // Re-decide from the un-banned row. `deactivatedAt` is what computeEntitlement
      // checks first, so it must be cleared before this is computed.
      const entitlement = computeEntitlement({ ...company, deactivatedAt: null }, new Date());
      await this.companyRepository.setEntitlementState(
        companyId,
        { isActive: entitlement.hasAccess, subscriptionStatus: entitlement.status },
        manager,
      );

      // Captured BEFORE the row is cleared: lifting a ban wipes `deactivatedBy` and
      // `deactivationReason`, so without this the record of why the company was ever
      // banned disappears at exactly the moment someone decides it was a mistake.
      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "company.unban",
          entityType: "company",
          entityId: companyId,
          before: {
            bannedAt: company.deactivatedAt?.toISOString() ?? null,
            bannedReason: company.deactivationReason ?? null,
          },
          after: { subscriptionStatus: entitlement.status, isActive: entitlement.hasAccess },
          // The unban's own note. It used to repeat the ban reason, so the log read as
          // two bans; that reason is already preserved in `before.bannedReason`.
          note: reason?.trim() ? `Ban lifted: ${reason.trim()}` : "Ban lifted",
        },
        manager,
      );

      logger.info(
        { companyId, status: entitlement.status, hasAccess: entitlement.hasAccess },
        "Company ban lifted",
      );
      return { status: entitlement.status, hasAccess: entitlement.hasAccess };
    });
  }
}
