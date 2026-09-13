import { AppDataSource } from "data-source";
import type { EntityManager } from "typeorm";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
import { INVITE_TTL_HOURS } from "@/config/onboarding";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { TokenRepository } from "@/repositories/TokenRepository";
import { UserRepository } from "@/repositories/UserRepository";
import { AuditService } from "@/services/AuditService";
import { EmailService } from "@/services/EmailService";
import { PasswordService } from "@/services/PasswordService";
import { readSmtpHealth } from "@/services/SmtpHealthStore";
import { TokenService } from "@/services/TokenService";
import { generateRandomToken } from "@/utils/crypto";
import type { TransactionRunner } from "@/utils/db";
import { assertEmailsDeliverable } from "@/utils/emailDeliverability";
import { computeEntitlement } from "@/utils/entitlement";
import { inviteResendBlock } from "@/utils/inviteResend";
import { logger } from "@/utils/logger";
import { isSmtpDeliveryDown } from "@/utils/smtpHealth";
import type { CreateCompanyInput } from "@/validation/schemas/admin.schema";

/** Admin onboarding: creating a company on someone's behalf and (re)sending its invite. */
export class AdminOnboardingService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly tokenRepository = new TokenRepository(),
    private readonly passwordService = new PasswordService(),
    private readonly tokenService = new TokenService(),
    private readonly emailService = new EmailService(),
    private readonly auditService = new AuditService(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

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
  ): Promise<{
    companyId: string;
    ownerEmail: string;
    compedUntil: Date | null;
    emailDeliveryDown: boolean;
  }> {
    const email = input.email.trim().toLowerCase();
    const compedUntil = input.compedUntil ? new Date(input.compedUntil) : null;

    if (compedUntil && compedUntil.getTime() <= Date.now()) {
      throw BadRequestError("The free-access date must be in the future.");
    }

    // Before the transaction: the set-password invite goes out the moment it commits,
    // and an operator's typo bounces against the SMTP mailbox exactly like a customer's.
    await assertEmailsDeliverable([
      { field: "email", value: email },
      { field: "contactEmail", value: input.contactEmail },
    ]);

    const result = await this.db.transaction(async (manager) => {
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

    // The invite is only queued. If the last real send was refused outright, it will
    // not arrive until email is fixed — tell the admin rather than let the UI imply it
    // went out. Best effort: a Redis blip must not fail a company that was created.
    let emailDeliveryDown = false;
    try {
      emailDeliveryDown = isSmtpDeliveryDown(await readSmtpHealth());
    } catch (err) {
      logger.warn({ err }, "Could not read SMTP health after creating a company");
    }

    logger.info(
      { companyId: result.company.id, actorId: actor.id, compedUntil },
      "Company onboarded by admin",
    );
    return { companyId: result.company.id, ownerEmail: email, compedUntil, emailDeliveryDown };
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
    await this.db.transaction(async (manager) => {
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
   * 400 for a self-registered company, 409 once the owner has set up the account. The
   * rule and its reasons live in utils/inviteResend.ts.
   */
  async resendInvite(
    actor: { id: string; email: string },
    companyId: string,
  ): Promise<{ message: string }> {
    const company = await this.companyRepository.findByIdWithOwner(companyId);
    if (!company?.owner) throw NotFoundError("Company not found");

    const createdByAdmin = (await this.companyRepository.adminCreatedIds([companyId])).has(
      companyId,
    );
    const block = inviteResendBlock({
      createdByAdmin,
      ownerEmailVerified: company.owner.emailVerifiedAt != null,
    });
    if (block) {
      throw block.status === 400 ? BadRequestError(block.message) : ConflictError(block.message);
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
}
