import { BadRequestError } from "@/errors/index";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { AccountDeletionService, type DeletionStatus } from "@/services/AccountDeletionService";
import { requireCompany } from "@/services/adminCompanyLookup";
import { AuditService } from "@/services/AuditService";
import { logger } from "@/utils/logger";

/**
 * Account deletion on the customer's behalf.
 *
 * The privacy policy tells customers to request deletion by emailing support. Until
 * now the only endpoints were company-authenticated, so the person who actually
 * receives that email had no way to action it — the working code existed and was
 * unreachable by the only party the policy points at. These close that gap.
 *
 * The alternative was doing it by hand in psql, which is genuinely dangerous here:
 * the purge is not a DELETE. Purchases and customers are hard-deleted, company and
 * owner rows are scrubbed in place, payments and subscriptions are retained as the
 * money ledger, and trial_identities is deliberately kept so closing an account does
 * not hand back a free trial. Four behaviours across five tables is not something
 * anyone should reproduce from memory.
 */
export class AdminDeletionService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly accountDeletionService = new AccountDeletionService(),
    private readonly auditService = new AuditService(),
  ) {}

  async getDeletionStatus(companyId: string): Promise<DeletionStatus> {
    await requireCompany(this.companyRepository, companyId);
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
    const company = await requireCompany(this.companyRepository, companyId);

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

  /** Calls off a pending deletion — for a customer who changed their mind. */
  async cancelDeletionForCompany(
    companyId: string,
    admin: { id: string; email: string },
    reason: string,
  ): Promise<void> {
    if (!reason.trim()) {
      throw BadRequestError("Please record why this deletion is being called off.");
    }
    const company = await requireCompany(this.companyRepository, companyId);
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
