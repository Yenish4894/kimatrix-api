import { AppDataSource } from "data-source";
import { BadRequestError, NotFoundError } from "@/errors/index";
import type { Company } from "@/entities/Company";
import { BulkEmailLog } from "@/entities/BulkEmailLog";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { TrialIdentityRepository } from "@/repositories/TrialIdentityRepository";
import type { TrialIdentity } from "@/entities/TrialIdentity";
import type { SubscriptionStatus } from "@/entities/Company";
import { computeEntitlement } from "@/utils/entitlement";
import { SubscriptionService } from "@/services/SubscriptionService";
import { AuditService } from "@/services/AuditService";
import { AccountDeletionService, type DeletionStatus } from "@/services/AccountDeletionService";
import { EmailService } from "@/services/EmailService";
import type {
  CompanyBusinessTypeFilter,
  CompanyStatusFilter,
  PlatformStats,
} from "@/repositories/CompanyRepository";
import { CustomerRepository } from "@/repositories/CustomerRepository";
import { TokenRepository } from "@/repositories/TokenRepository";
import { logger } from "@/utils/logger";

export interface ListCompaniesInput {
  page: number;
  limit: number;
  search?: string;
  status?: CompanyStatusFilter;
  businessType?: CompanyBusinessTypeFilter;
}

export interface PlatformStatsResult extends PlatformStats {
  totalCustomers: number;
  totalPurchases: number;
  totalSpend: string;
}

export class SuperAdminService {
  private companyRepository = new CompanyRepository();
  private trialIdentityRepository = new TrialIdentityRepository();
  private subscriptionService = new SubscriptionService();
  private accountDeletionService = new AccountDeletionService();
  private auditService = new AuditService();
  private customerRepository = new CustomerRepository();
  private tokenRepository = new TokenRepository();

  async listCompanies(input: ListCompaniesInput): Promise<{ items: Company[]; total: number }> {
    return this.companyRepository.listForAdmin(input);
  }

  async getCompany(companyId: string): Promise<Company> {
    const company = await this.companyRepository.findByIdWithOwner(companyId);
    if (!company) {
      throw NotFoundError("Company not found");
    }
    return company;
  }

  async deactivateCompany(
    actor: { id: string; email: string },
    companyId: string,
    reason: string,
  ): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
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
  ): Promise<{ status: string; hasAccess: boolean }> {
    return AppDataSource.transaction(async (manager) => {
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
          note: company.deactivationReason ?? null,
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
    adminUserId: string,
  ): Promise<{ trialEndsAt: Date; status: SubscriptionStatus }> {
    return AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      if (!company) throw NotFoundError("Company not found");
      if (company.deactivatedAt != null) {
        throw BadRequestError("Reactivate this company before granting a trial.");
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

      logger.info({ companyId, adminUserId, days, trialEndsAt }, "Trial extended by admin");
      return { trialEndsAt, status: entitlement.status };
    });
  }

  /**
   * Sets or clears the admin comp — the explicit "free, forever or until X" override,
   * and the only thing that grants access without payment.
   *
   * A reason is required for a grant. Comping is a money decision, and an unexplained
   * one is indistinguishable from a mistake when someone reads it back in six months.
   */
  async setComp(
    companyId: string,
    params: { isComped: boolean; compedUntil: Date | null; reason: string | null },
    adminUserId: string,
  ): Promise<{ status: SubscriptionStatus; hasAccess: boolean }> {
    return AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      if (!company) throw NotFoundError("Company not found");
      if (params.isComped && !params.reason?.trim()) {
        throw BadRequestError("Please give a reason for this complimentary access.");
      }

      const compedUntil = params.isComped ? params.compedUntil : null;

      await this.companyRepository.setComp(
        {
          companyId,
          isComped: params.isComped,
          compedUntil,
          reason: params.isComped ? (params.reason?.trim() ?? null) : null,
          grantedByUserId: params.isComped ? adminUserId : null,
        },
        manager,
      );

      const entitlement = computeEntitlement(
        { ...company, isComped: params.isComped, compedUntil },
        new Date(),
      );
      await this.companyRepository.setEntitlementState(
        companyId,
        { isActive: entitlement.hasAccess, subscriptionStatus: entitlement.status },
        manager,
      );

      logger.info(
        { companyId, adminUserId, isComped: params.isComped, compedUntil },
        params.isComped ? "Complimentary access granted" : "Complimentary access revoked",
      );
      return { status: entitlement.status, hasAccess: entitlement.hasAccess };
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
    adminUserId: string,
  ): Promise<void> {
    if (!reason.trim()) {
      throw BadRequestError("Please give a reason for releasing this identifier.");
    }
    const released = await this.trialIdentityRepository.release(
      identityId,
      adminUserId,
      reason.trim(),
    );
    if (!released) {
      // Either the id is unknown or it was already released. Both mean "nothing to
      // do", and distinguishing them tells an admin nothing actionable.
      throw NotFoundError("That identifier was not found, or has already been released.");
    }
    logger.info({ identityId, adminUserId }, "Trial identity released by admin");
  }

  async getPlatformStats(): Promise<PlatformStatsResult> {
    const [companyStats, aggregates] = await Promise.all([
      this.companyRepository.getPlatformStats(),
      this.customerRepository.getPlatformAggregates(),
    ]);
    return { ...companyStats, ...aggregates };
  }

  // ─── Account deletion on the customer's behalf ────────────────────────────
  //
  // The privacy policy tells customers to request deletion by emailing support. Until
  // now the only endpoints were company-authenticated, so the person who actually
  // receives that email had no way to action it — the working code existed and was
  // unreachable by the only party the policy points at. These close that gap.
  //
  // The alternative was doing it by hand in psql, which is genuinely dangerous here:
  // the purge is not a DELETE. Purchases and customers are hard-deleted, company and
  // owner rows are scrubbed in place, payments and subscriptions are retained as the
  // money ledger, and trial_identities is deliberately kept so closing an account does
  // not hand back a free trial. Four behaviours across five tables is not something
  // anyone should reproduce from memory.

  async getDeletionStatus(companyId: string): Promise<DeletionStatus> {
    await this.getCompany(companyId);
    return this.accountDeletionService.getStatus(companyId);
  }

  /**
   * Starts the grace period on behalf of a customer who asked by email.
   *
   * `reason` is required and written to the audit log. A deletion request that arrives
   * out of band has no other record that it was ever made — without the reason there is
   * nothing tying the erasure to the customer who asked for it, which is exactly what
   * you need six months later when someone queries why an account vanished.
   *
   * Attributed to the ADMIN, not the customer: `deletionRequestedBy` should name whoever
   * actually pressed the button, so the audit trail does not claim the customer clicked
   * something they never saw.
   */
  async requestDeletionForCompany(
    companyId: string,
    admin: { id: string; email: string },
    reason: string,
  ): Promise<DeletionStatus> {
    if (!reason.trim()) {
      throw BadRequestError("Please record who asked for this deletion and how.");
    }
    const company = await this.getCompany(companyId);

    const status = await this.accountDeletionService.requestDeletion(companyId, admin.id);

    await this.auditService.record({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "company.deletion_request",
      entityType: "company",
      entityId: companyId,
      after: { companyName: company.name, purgeAt: status.purgeAt },
      note: reason.trim(),
    });

    logger.warn(
      { companyId, adminUserId: admin.id, purgeAt: status.purgeAt },
      "Account deletion requested by admin on the customer's behalf",
    );
    return status;
  }

  // ─── Bulk email ───────────────────────────────────────────────────────────

  async sendBulkEmail(
    admin: { id: string; email: string },
    subject: string,
    body: string,
    companyIds: string[],
    extraEmails: string[] = [],
    attachment?: { path: string; filename: string; size: number },
  ): Promise<{ recipientCount: number; logId: string }> {
    if (!subject.trim()) throw BadRequestError("Subject is required.");
    if (!body.trim()) throw BadRequestError("Body is required.");
    if (!companyIds.length && !extraEmails.length) {
      throw BadRequestError("Select at least one company, or add an email address.");
    }

    // Fetch only the owner emails for the requested companies.
    const found = companyIds.length
      ? await this.companyRepository.findByIdsWithOwner(companyIds)
      : [];
    // A company whose owner row is missing would throw on `.owner.email` and take the
    // whole broadcast down with it. Skip it and deliver to everyone else instead.
    const companies = found.filter((c) => c.owner?.email);
    if (companies.length < found.length) {
      logger.warn(
        { requested: companyIds.length, deliverable: companies.length },
        "Bulk email: some companies have no owner email and were skipped",
      );
    }

    // One address may be both a company owner and typed into the extra box. Sending
    // the same announcement twice to the same person looks like a broken system, so
    // the address decides identity, not which list it came from.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const address of [...companies.map((c) => c.owner.email), ...extraEmails]) {
      const key = address.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      recipients.push(address.trim());
    }

    if (!recipients.length) throw BadRequestError("No valid recipients found.");

    const emailService = new EmailService();
    const repo = AppDataSource.getRepository(BulkEmailLog);

    // Enqueue one job per recipient so individual failures don't block others. Every
    // job points at the same file on disk rather than carrying a copy of it.
    await Promise.all(
      recipients.map((to) =>
        emailService.enqueueBulkEmail({
          to,
          subject: subject.trim(),
          body: body.trim(),
          ...(attachment
            ? { attachment: { path: attachment.path, filename: attachment.filename } }
            : {}),
        }),
      ),
    );

    const log = repo.create({
      subject: subject.trim(),
      body: body.trim(),
      sentByEmail: admin.email,
      attachmentFilename: attachment?.filename ?? null,
      attachmentSize: attachment?.size ?? null,
      // What actually went out, not what was asked for — the two differ whenever a
      // company is skipped or an address appears in both lists.
      recipientCount: recipients.length,
      recipientIds: companies.map((c) => c.id),
      extraEmails,
      sentBy: { id: admin.id } as never,
    });
    const saved = await repo.save(log);

    logger.info(
      {
        logId: saved.id,
        adminId: admin.id,
        recipientCount: recipients.length,
        companies: companies.length,
        extra: extraEmails.length,
      },
      "Bulk email enqueued",
    );
    return { recipientCount: recipients.length, logId: saved.id };
  }

  async listBulkEmailLogs(
    page: number,
    limit: number,
  ): Promise<{ items: BulkEmailLog[]; total: number }> {
    const repo = AppDataSource.getRepository(BulkEmailLog);
    const [items, total] = await repo.findAndCount({
      order: { sentAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total };
  }

  /** Calls off a pending deletion — for a customer who changed their mind. */
  async cancelDeletionForCompany(
    companyId: string,
    admin: { id: string; email: string },
    reason: string,
  ): Promise<void> {
    if (!reason.trim()) {
      throw BadRequestError("Please record why this deletion is being called off.");
    }
    const company = await this.getCompany(companyId);
    await this.accountDeletionService.cancelDeletion(companyId);

    await this.auditService.record({
      actorUserId: admin.id,
      actorEmail: admin.email,
      action: "company.deletion_cancel",
      entityType: "company",
      entityId: companyId,
      after: { companyName: company.name },
      note: reason.trim(),
    });

    logger.warn({ companyId, adminUserId: admin.id }, "Account deletion cancelled by admin");
  }
}
