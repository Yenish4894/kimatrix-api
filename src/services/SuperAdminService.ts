import { AppDataSource } from "data-source";
import type { EntityManager } from "typeorm";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
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
import { UserRepository } from "@/repositories/UserRepository";
import { PasswordService } from "@/services/PasswordService";
import { TokenService } from "@/services/TokenService";
import { generateRandomToken } from "@/utils/crypto";
import { INVITE_TTL_HOURS } from "@/config/onboarding";
import type { AuditLogQueryInput, CreateCompanyInput } from "@/validation/schemas/admin.schema";
import type {
  ListCustomersQueryInput,
  ListPurchasesQueryInput,
} from "@/validation/schemas/company.schema";
import type { Customer } from "@/entities/Customer";
import type { Purchase } from "@/entities/Purchase";
import { PurchaseRepository } from "@/repositories/PurchaseRepository";
import { LuckyDrawRepository, type DrawHistoryRow } from "@/repositories/LuckyDrawRepository";
import { logger } from "@/utils/logger";

export interface AuditLogItem {
  id: string;
  createdAt: Date;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

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
  /** Spend per company country; amounts are in that country's currency. */
  spendByCountry: { country: string; total: string }[];
}

export class SuperAdminService {
  private companyRepository = new CompanyRepository();
  private trialIdentityRepository = new TrialIdentityRepository();
  private subscriptionService = new SubscriptionService();
  private accountDeletionService = new AccountDeletionService();
  private auditService = new AuditService();
  private customerRepository = new CustomerRepository();
  private tokenRepository = new TokenRepository();
  private userRepository = new UserRepository();
  private passwordService = new PasswordService();
  private tokenService = new TokenService();
  private emailService = new EmailService();

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

  /**
   * Creates a company on someone's behalf, for onboarding a business the operator
   * already knows rather than sending them through public signup.
   *
   * Three things differ from `AuthService.registerCompany`:
   *
   *  - **No password is chosen here.** The row gets an unguessable random hash that
   *    nobody holds, and the owner sets a real one from an emailed link. An admin
   *    never handles a customer's credentials, and the link doubles as proof the
   *    address works.
   *  - **Access comes from a comp, not a trial.** The trial identity registry is
   *    therefore untouched: it exists to stop strangers farming free trials, and a
   *    vouched-for business is not that. Nothing here burns their one trial, so they
   *    can still self-serve one later if the comp lapses.
   *  - **The email is marked verified on password set**, not here. See
   *    `confirmPasswordReset` — receiving the link is the proof.
   */
  async createCompany(
    actor: { id: string; email: string },
    input: CreateCompanyInput,
  ): Promise<{ companyId: string; ownerEmail: string; compedUntil: Date | null }> {
    const email = input.email.trim().toLowerCase();
    const compedUntil = input.compedUntil ? new Date(input.compedUntil) : null;

    if (compedUntil && compedUntil.getTime() <= Date.now()) {
      throw BadRequestError("The free-access date must be in the future.");
    }

    const result = await AppDataSource.transaction(async (manager) => {
      await this.assertOnboardingIdentifiersFree(email, input.registrationNumber, manager);
      const now = new Date();

      // A random hash nobody knows. The account is unreachable until the owner sets a
      // password from the invite, so there is no default credential to leak or guess.
      const unusablePassword = await this.passwordService.hash(generateRandomToken(32));

      const user = await this.userRepository.create(
        {
          email,
          username: null,
          password: unusablePassword,
          userType: "company",
          isActive: true,
          passwordChangedAt: now,
        },
        manager,
      );

      const company = await this.companyRepository.create(
        {
          owner: user,
          name: input.name,
          streetAddress: input.streetAddress,
          city: input.city,
          state: input.state,
          country: input.country,
          postalCode: input.postalCode || null,
          registrationNumber: input.registrationNumber,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
          whatsappNumber: input.whatsappNumber ?? null,
          businessType: input.businessType,
          // Opted in: the operator onboarding them is the relationship, and bulk email
          // (which now skips opted-out companies) is how that operator reaches them. At
          // false, every admin-created company silently vanished from announcements.
          // The owner can still opt out from their profile.
          promoEmailOptIn: true,
          // Accepted by the operator on the customer's behalf, which is the honest
          // record of what happened: nobody clicked a checkbox here.
          termsAcceptedAt: now,
          isActive: true,
          joinedAt: now,
          qrToken: generateRandomToken(24),
          isComped: true,
          compedUntil,
          compReason: input.compReason.trim(),
          compGrantedBy: { id: actor.id } as never,
          compDrawSpins: input.compDrawSpins ?? 0,
          compDrawSpinsGrantedAt: (input.compDrawSpins ?? 0) > 0 ? now : null,
        },
        manager,
      );

      // Derived rather than assumed, so the projection matches what the gate will
      // decide on the next request.
      const entitlement = computeEntitlement(
        {
          isActive: true,
          deactivatedAt: null,
          isComped: true,
          compedUntil,
          subscriptionExpiresAt: null,
          trialStartedAt: null,
          trialEndsAt: null,
        },
        now,
      );
      await this.companyRepository.setEntitlementState(
        company.id,
        { isActive: entitlement.hasAccess, subscriptionStatus: entitlement.status },
        manager,
      );

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "company.create",
          entityType: "company",
          entityId: company.id,
          before: null,
          after: {
            name: company.name,
            ownerEmail: email,
            compedUntil: compedUntil ? compedUntil.toISOString() : null,
          },
          note: input.compReason.trim(),
        },
        manager,
      );

      return { user, company };
    });

    // Outside the transaction: the company exists and is correct whether or not the
    // mail server is reachable. A failed invite is recoverable from the sign-in page
    // with "Forgot password"; a rolled-back company is not recoverable at all.
    try {
      await this.issueInvite(result.user, email, result.company.name, compedUntil);
    } catch (err) {
      logger.error(
        { err, companyId: result.company.id, email },
        "Company created but the invite email could not be sent; the owner must use Forgot password",
      );
    }

    logger.info(
      { companyId: result.company.id, actorId: actor.id, compedUntil },
      "Company onboarded by admin",
    );
    return { companyId: result.company.id, ownerEmail: email, compedUntil };
  }

  /**
   * Issues the set-password invite: retires any live reset link, stores a fresh one
   * (INVITE_TTL_HOURS) and queues the invite email. Throws on failure; each caller
   * decides whether that fails its request.
   */
  private async issueInvite(
    user: { id: string },
    email: string,
    companyName: string,
    freeUntil: Date | null,
  ): Promise<void> {
    const rawToken = generateRandomToken(32);
    await AppDataSource.transaction(async (manager) => {
      await this.tokenRepository.invalidateActivePasswordResets(user.id, manager);
      await this.tokenRepository.create(
        {
          user: user as never,
          type: "password_reset",
          tokenHash: this.tokenService.hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000),
          ipAddress: null,
          userAgent: null,
        },
        manager,
      );
    });
    await this.emailService.enqueueAccountInvite({
      to: email,
      setPasswordToken: rawToken,
      companyName,
      expiresInHours: INVITE_TTL_HOURS,
      freeUntil,
    });
  }

  /**
   * Re-sends the invite of an admin-onboarded company whose owner never set a password
   * (the invite expired, or went to spam).
   *
   * 409 once the owner's email is verified: setting a password from the invite verifies
   * it, so the invite has done its job and "Forgot password" is the route from there.
   * Also 409 for a self-registered company. It never had an invite, and a set-password
   * link would verify the address through confirmPasswordReset, which does not start the
   * free trial that verifying through confirmEmailVerification would.
   */
  async resendInvite(
    actor: { id: string; email: string },
    companyId: string,
  ): Promise<{ message: string }> {
    const company = await this.companyRepository.findByIdWithOwner(companyId);
    if (!company?.owner) throw NotFoundError("Company not found");

    if (company.owner.emailVerifiedAt != null) {
      throw ConflictError(
        "The owner has already set up their account, so there is no invite to resend. They can use Forgot password on the sign-in page.",
      );
    }
    const adminCreated = (await AppDataSource.query(
      `SELECT 1 AS x FROM "admin_audit_log"
        WHERE "action" = 'company.create' AND "entity_id" = $1
        LIMIT 1`,
      [companyId],
    )) as unknown[];
    if (adminCreated.length === 0) {
      throw ConflictError(
        "This company signed up by itself, so it has no invite to resend. The owner can resend the verification email from their dashboard.",
      );
    }

    const ownerEmail = company.owner.email;
    await this.issueInvite(
      company.owner,
      ownerEmail,
      company.name,
      company.compedUntil ? new Date(company.compedUntil) : null,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: "company.invite_resend",
      entityType: "company",
      entityId: companyId,
      after: { ownerEmail },
    });

    logger.info({ companyId, actorId: actor.id }, "Company invite re-sent by admin");
    return { message: `Invite re-sent to ${ownerEmail}.` };
  }

  /**
   * The audit trail, newest first.
   *
   * `companyId` matches rows about the company itself (entity_id = companyId) and rows
   * about its payments, its purchases (voids) and its owner's login (email changes),
   * whose entity_id is that row's id rather than the company's.
   *
   * `to` as a bare date (YYYY-MM-DD) includes that whole UTC day; as a full timestamp
   * it is used inclusively as given.
   */
  async listAuditLog(q: AuditLogQueryInput): Promise<{ items: AuditLogItem[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (q.companyId) {
      // Bound twice: once compared with the varchar entity_id, once with uuid columns,
      // so Postgres infers each parameter's type cleanly and the uuid indexes are used.
      const asText = bind(q.companyId);
      const asUuid = bind(q.companyId);
      where.push(`(
          a."entity_id" = ${asText}
          OR (a."entity_type" = 'payment' AND a."entity_id" IN (
                SELECT pay."id"::text FROM "payments" pay WHERE pay."company_id" = ${asUuid}))
          OR (a."entity_type" = 'purchase' AND a."entity_id" IN (
                SELECT pu."id"::text FROM "purchases" pu WHERE pu."company_id" = ${asUuid}))
          OR (a."entity_type" = 'user' AND a."entity_id" IN (
                SELECT co."owner_user_id"::text FROM "companies" co WHERE co."id" = ${asUuid}))
        )`);
    }
    if (q.action) where.push(`a."action" = ${bind(q.action)}`);
    if (q.from) where.push(`a."created_at" >= ${bind(q.from)}`);
    if (q.to !== undefined) {
      if (typeof q.to === "string") {
        const [y, m, d] = q.to.split("-").map(Number) as [number, number, number];
        where.push(`a."created_at" < ${bind(new Date(Date.UTC(y, m - 1, d + 1)))}`);
      } else {
        where.push(`a."created_at" <= ${bind(q.to)}`);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const [countRow] = (await AppDataSource.query(
      `SELECT count(*)::int AS total FROM "admin_audit_log" a ${whereSql}`,
      [...params],
    )) as { total: number }[];

    const limitParam = bind(q.limit);
    const offsetParam = bind((q.page - 1) * q.limit);
    const rows = (await AppDataSource.query(
      `SELECT a."id", a."created_at", a."actor_email", a."action", a."entity_type",
              a."entity_id", a."note", a."before", a."after"
         FROM "admin_audit_log" a
         ${whereSql}
        ORDER BY a."created_at" DESC, a."id" DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    )) as {
      id: string;
      created_at: Date;
      actor_email: string;
      action: string;
      entity_type: string;
      entity_id: string;
      note: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }[];

    return {
      total: Number(countRow?.total ?? 0),
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        actorEmail: r.actor_email,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        note: r.note ?? null,
        before: r.before ?? null,
        after: r.after ?? null,
      })),
    };
  }

  /** Same repository call and item shape as GET /api/company/customers. */
  async listCompanyCustomers(
    companyId: string,
    q: ListCustomersQueryInput,
  ): Promise<{ items: Customer[]; total: number }> {
    await this.getCompany(companyId);
    return this.customerRepository.listByCompany({
      companyId,
      page: q.page,
      limit: q.limit,
      ...(q.search !== undefined ? { search: q.search } : {}),
      ...(q.sortBy !== undefined ? { sortBy: q.sortBy } : {}),
      ...(q.sortOrder !== undefined ? { sortOrder: q.sortOrder } : {}),
    });
  }

  /** Same repository call and item shape as GET /api/company/purchases (voided rows included, flagged). */
  async listCompanyPurchases(
    companyId: string,
    q: ListPurchasesQueryInput,
  ): Promise<{ items: Purchase[]; total: number }> {
    await this.getCompany(companyId);
    return new PurchaseRepository().listByCompany({
      companyId,
      page: q.page,
      limit: q.limit,
      ...(q.search !== undefined ? { search: q.search } : {}),
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.sortBy !== undefined ? { sortBy: q.sortBy } : {}),
      ...(q.sortOrder !== undefined ? { sortOrder: q.sortOrder } : {}),
    });
  }

  /** Same rows as the history in GET /api/company/draws. */
  async getCompanyDraws(companyId: string): Promise<{ history: DrawHistoryRow[] }> {
    await this.getCompany(companyId);
    return {
      history: await new LuckyDrawRepository().history(companyId, AppDataSource.manager),
    };
  }

  /**
   * Same shape as registration's check, minus username: an onboarded owner has none,
   * so there is nothing to collide on and no name for the admin to invent.
   */
  private async assertOnboardingIdentifiersFree(
    email: string,
    registrationNumber: string,
    manager: EntityManager,
  ): Promise<void> {
    const [emailTaken, regTaken] = await Promise.all([
      this.userRepository.findByEmail(email, manager),
      this.companyRepository.findByRegistrationNumber(registrationNumber, manager),
    ]);
    const details = [];
    if (emailTaken) details.push({ field: "email", message: "This email already has an account." });
    if (regTaken)
      details.push({
        field: "registrationNumber",
        message: "This registration number is already in use by another company.",
      });
    if (details.length > 0) {
      throw ConflictError(
        "Some of these details are already in use. Please review the highlighted fields.",
        details,
      );
    }
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
  ): Promise<{
    trialEndsAt: Date;
    status: SubscriptionStatus;
    /** False when the owner never confirmed their email — see the note below. */
    ownerEmailVerified: boolean;
  }> {
    return AppDataSource.transaction(async (manager) => {
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

      logger.info({ companyId, adminUserId, days, trialEndsAt }, "Trial extended by admin");
      return { trialEndsAt, status: entitlement.status, ownerEmailVerified };
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
    params: {
      isComped: boolean;
      compedUntil: Date | null;
      reason: string | null;
      drawSpins?: number;
    },
    actor: { id: string; email: string },
  ): Promise<{ status: SubscriptionStatus; hasAccess: boolean }> {
    const adminUserId = actor.id;
    return AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      if (!company) throw NotFoundError("Company not found");
      if (params.isComped && !params.reason?.trim()) {
        throw BadRequestError("Please give a reason for this complimentary access.");
      }

      const compedUntil = params.isComped ? params.compedUntil : null;

      // Omitting spins leaves them as they are; revoking the comp revokes them too.
      const drawSpins = params.isComped ? (params.drawSpins ?? company.compDrawSpins ?? 0) : 0;
      // The draw window opens when spins are first granted and stays put while they
      // are merely adjusted — otherwise topping up a spin would quietly re-admit the
      // customers who already won.
      const keepWindow =
        company.isComped && company.compDrawSpins > 0 && company.compDrawSpinsGrantedAt != null;
      const drawSpinsGrantedAt =
        drawSpins === 0 ? null : keepWindow ? company.compDrawSpinsGrantedAt : new Date();

      await this.companyRepository.setComp(
        {
          companyId,
          isComped: params.isComped,
          compedUntil,
          reason: params.isComped ? (params.reason?.trim() ?? null) : null,
          grantedByUserId: params.isComped ? adminUserId : null,
          drawSpins,
          drawSpinsGrantedAt,
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

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: params.isComped ? "company.comp" : "company.uncomp",
          entityType: "company",
          entityId: companyId,
          before: {
            isComped: company.isComped,
            compedUntil: company.compedUntil ? new Date(company.compedUntil).toISOString() : null,
            drawSpins: company.compDrawSpins,
          },
          after: {
            isComped: params.isComped,
            compedUntil: compedUntil ? new Date(compedUntil).toISOString() : null,
            drawSpins,
          },
          note: params.isComped ? (params.reason?.trim() ?? null) : null,
        },
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
  ): Promise<{ recipientCount: number; logId: string; skippedOptedOut: number }> {
    if (!subject.trim()) throw BadRequestError("Subject is required.");
    if (!body.trim()) throw BadRequestError("Body is required.");
    if (!companyIds.length && !extraEmails.length) {
      throw BadRequestError("Select at least one company, or add an email address.");
    }

    // Fetch only the owner emails for the requested companies.
    const found = companyIds.length
      ? await this.companyRepository.findByIdsWithOwner(companyIds)
      : [];
    // Enforced here, not left to whoever ticks the boxes: the footer of every one of
    // these emails promises that opting out stops them, so an admin selecting an
    // opted-out company must not be able to break that promise. Extra addresses typed
    // by hand are not companies and have no preference to honour.
    const optedIn = found.filter((c) => c.promoEmailOptIn !== false);
    const skippedOptedOut = found.length - optedIn.length;

    // A company whose owner row is missing would throw on `.owner.email` and take the
    // whole broadcast down with it. Skip it and deliver to everyone else instead.
    const companies = optedIn.filter((c) => c.owner?.email);
    if (companies.length < optedIn.length) {
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

    if (!recipients.length) {
      throw BadRequestError(
        skippedOptedOut > 0
          ? "Every selected company has opted out of these emails."
          : "No valid recipients found.",
      );
    }

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
        skippedOptedOut,
        extra: extraEmails.length,
      },
      "Bulk email enqueued",
    );
    return { recipientCount: recipients.length, logId: saved.id, skippedOptedOut };
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
