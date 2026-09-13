import { AppDataSource } from "data-source";
import type { SubscriptionStatus } from "@/entities/Company";
import type { TrialIdentity } from "@/entities/TrialIdentity";
import { BadRequestError, NotFoundError } from "@/errors/index";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { TrialIdentityRepository } from "@/repositories/TrialIdentityRepository";
import { AuditService } from "@/services/AuditService";
import type { TransactionRunner } from "@/utils/db";
import { computeEntitlement } from "@/utils/entitlement";
import { logger } from "@/utils/logger";

/** Admin trial tools: granting/extending a trial and the trial identity registry. */
export class AdminTrialService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly trialIdentityRepository = new TrialIdentityRepository(),
    private readonly auditService = new AuditService(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

  /**
   * Grants or extends a free trial. Stacks onto any remaining trial time.
   *
   * Refuses on a deactivated company: handing a trial to an account we have banned
   * changes nothing, because the ban outranks every other state in computeEntitlement,
   * and it would read in the audit log as though access had been restored.
   */
  async extendTrial(
    companyId: string,
    days: number,
    actor: { id: string; email: string },
  ): Promise<{
    trialEndsAt: Date;
    status: SubscriptionStatus;
    /** False when the owner never confirmed their email — see the note below. */
    ownerEmailVerified: boolean;
  }> {
    const adminUserId = actor.id;
    return this.db.transaction(async (manager) => {
      const company = await this.companyRepository.findByIdWithOwner(companyId, manager);
      if (!company) throw NotFoundError("Company not found");
      if (company.deactivatedAt != null) {
        throw BadRequestError("Reactivate this company before granting a trial.");
      }

      // Reported, not blocked.
      //
      // A self-serve trial only starts once the owner confirms their email, which is
      // what keeps unreal addresses out of the mail pipeline. Granting a trial here
      // walks around that check — which is how test@gmail.com and tvb@gmail.com came
      // to hold trials, and in turn how the expiry cron came to email two addresses
      // that did not exist and got the mailbox suspended.
      //
      // Blocking outright would be wrong: granting a trial to someone the operator has
      // spoken to directly is a legitimate thing to do. But the admin should know the
      // consequence, because expiry notices now deliberately skip unverified owners:
      // this company will receive no warning before its trial lapses.
      const ownerEmailVerified = company.owner?.emailVerifiedAt != null;
      if (!ownerEmailVerified) {
        logger.warn(
          { companyId, adminUserId, ownerEmail: company.owner?.email },
          "Trial granted to a company whose owner has not confirmed their email — it will receive no expiry notices",
        );
      }

      const now = new Date();
      const trialEndsAt = await this.companyRepository.extendTrial(
        { companyId, days, now },
        manager,
      );

      const entitlement = computeEntitlement({ ...company, trialEndsAt }, now);
      await this.companyRepository.setEntitlementState(
        companyId,
        { isActive: entitlement.hasAccess, subscriptionStatus: entitlement.status },
        manager,
      );

      // In the same transaction as the change, like a comp: free access with no record
      // of who granted it is exactly what the audit found on two live companies.
      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "company.trial_extend",
          entityType: "company",
          entityId: companyId,
          before: {
            trialEndsAt: company.trialEndsAt ? new Date(company.trialEndsAt).toISOString() : null,
            subscriptionStatus: company.subscriptionStatus,
          },
          after: {
            trialEndsAt: trialEndsAt.toISOString(),
            subscriptionStatus: entitlement.status,
            days,
            ownerEmailVerified,
          },
          note: ownerEmailVerified
            ? null
            : "Owner has not confirmed their email, so no expiry notices will be sent.",
        },
        manager,
      );

      logger.info({ companyId, adminUserId, days, trialEndsAt }, "Trial extended by admin");
      return { trialEndsAt, status: entitlement.status, ownerEmailVerified };
    });
  }

  /** The burned identifiers for one company, for the support screen. */
  async listTrialIdentities(companyId: string): Promise<TrialIdentity[]> {
    return this.trialIdentityRepository.findByCompany(companyId);
  }

  /**
   * Hands a burned email address or phone number back so it can start a trial again.
   *
   * This is the safety valve for the one real weakness in the trial registry: a third
   * party can burn someone else's contact email or phone by entering it during their
   * own registration. Without this tool that person can never take a trial and there is
   * no self-service route back, which is why it ships alongside the registry rather
   * than after it.
   */
  async releaseTrialIdentity(
    identityId: string,
    reason: string,
    actor: { id: string; email: string },
  ): Promise<void> {
    if (!reason.trim()) {
      throw BadRequestError("Please give a reason for releasing this identifier.");
    }
    await this.db.transaction(async (manager) => {
      const released = await this.trialIdentityRepository.release(
        identityId,
        actor.id,
        reason.trim(),
        manager,
      );
      if (!released) {
        // Either the id is unknown or it was already released. Both mean "nothing to
        // do", and distinguishing them tells an admin nothing actionable.
        throw NotFoundError("That identifier was not found, or has already been released.");
      }

      // Audited because a release re-opens a free trial. The masked preview only — the
      // registry never stores the identifier itself, and the log must not either.
      const identity = await this.trialIdentityRepository.findSummary(identityId, manager);
      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "trial_identity.release",
          entityType: "trial_identity",
          entityId: identityId,
          before: null,
          after: {
            identifierType: identity?.identifierType ?? null,
            preview: identity?.preview ?? null,
            companyId: identity?.companyId ?? null,
          },
          note: reason.trim(),
        },
        manager,
      );
    });
    logger.info({ identityId, adminUserId: actor.id }, "Trial identity released by admin");
  }
}
