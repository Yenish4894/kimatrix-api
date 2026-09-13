import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import type { User } from "@/entities/User";
import { Company } from "@/entities/Company";
import { UserRepository } from "@/repositories/UserRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { EmailService } from "@/services/EmailService";
import { NotificationService } from "@/services/NotificationService";
import { PasswordService } from "@/services/PasswordService";
import { SettingsService } from "@/services/SettingsService";
import { TrialIdentityService } from "@/services/TrialIdentityService";
import { TokenService, type IssuedTokens } from "@/services/TokenService";
import { config } from "@/config/index";
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from "@/errors/index";
import { logger } from "@/utils/logger";
import { generateRandomToken } from "@/utils/crypto";
import { assertEmailsDeliverable } from "@/utils/emailDeliverability";
import { TokenRepository } from "@/repositories/TokenRepository";
import { emailDomainForLog } from "@/utils/redact";
import { getRedisClient } from "@/config/redis.client";
import { emailQueue } from "@/queues/email.queue";
import {
  runRegistration,
  sendRegistrationAttemptNotice,
  type ExistingAccount,
  type RegistrationAccepted,
} from "@/utils/registrationFlow";
import type {
  LoginInput,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RefreshTokenInput,
  RegisterCompanyInput,
} from "@/validation/schemas/auth.schema";

export interface RegisterCompanyContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface LoginContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface LoginResult {
  user: Pick<User, "id" | "email" | "username" | "userType" | "isActive">;
  companyId?: string;
  companyIsActive?: boolean;
  tokens: IssuedTokens;
}

/**
 * The whole success payload of public registration: `{ status: "check_email" }`, and
 * nothing else — no session, no profile, no trial hint. It is identical whether an
 * account was created or the login email already had one (audit SEC-2/3); see
 * utils/registrationFlow.ts.
 */
export type RegisterCompanyResult = RegistrationAccepted;

export interface RefreshResult {
  user: Pick<User, "id" | "email" | "username" | "userType" | "isActive">;
  companyId?: string;
  companyIsActive?: boolean;
  tokens: IssuedTokens;
}

/**
 * Internal marker, never surfaced to a caller.
 *
 * Reuse detection has to revoke every session the user holds — but it is raised from
 * inside `AppDataSource.transaction`, and throwing there ROLLS BACK anything the same
 * transaction just wrote. Revoking in place therefore looked correct in the code and
 * did nothing at all: the stolen token was rejected, and every other token in the
 * family, including the one the thief had just rotated into, stayed live. Verified by
 * replaying a spent token and then successfully refreshing with its successor.
 *
 * So the transaction only *decides*; the revocation runs afterwards, in its own.
 */
class SessionReuseDetected extends Error {
  constructor(
    public readonly userId: string,
    public readonly tokenId: string,
    public readonly reason: string,
  ) {
    super("session reuse detected");
  }
}

export class AuthService {
  private userRepository = new UserRepository();
  private companyRepository = new CompanyRepository();
  private settingsService = new SettingsService();
  private trialIdentityService = new TrialIdentityService();
  private passwordService = new PasswordService();
  private tokenService = new TokenService();
  private tokenRepository = new TokenRepository();
  private emailService = new EmailService();
  private notificationService = new NotificationService();

  /**
   * Public self-registration. Does NOT sign the user in: they confirm their email and
   * then log in (an unverified login is allowed, as before).
   *
   * If the login email already has an account, nothing is created and the caller gets
   * exactly the same answer as a successful signup; the account's owner is emailed
   * instead. Username and registration-number conflicts are still reported (they are
   * not personal data), and are decided independently of the email — see
   * runRegistration for why the ordering matters.
   *
   * Timing: both paths pay for the deliverability checks, the bcrypt hash and one
   * transaction with the same lookups. Only a new account adds two INSERTs; all mail
   * work (verification link, existing-account notice, the Redis dedupe) happens after
   * the response and is not awaited.
   */
  async registerCompany(
    input: RegisterCompanyInput,
    context: RegisterCompanyContext,
  ): Promise<RegisterCompanyResult> {
    const email = input.email.trim().toLowerCase();
    const username = input.username.trim();

    // First, before the password hash, the transaction and the verification token: an
    // address that fails here must never have anything sent to it. Both are checked
    // because both receive mail from us. These errors say nothing about whether an
    // account exists, so they may stay specific.
    await assertEmailsDeliverable([
      { field: "email", value: email },
      { field: "contactEmail", value: input.contactEmail },
    ]);

    // Hashed on every path, taken email included, so the dominant cost is the same.
    const passwordHash = await this.passwordService.hash(input.password);

    return runRegistration<EntityManager>({
      transaction: (work) => AppDataSource.transaction(work),
      assertOtherIdentifiersFree: (manager) =>
        this.assertOtherIdentifiersFree(username, input.registrationNumber, manager),
      findAccountByEmail: (manager) => this.userRepository.findByEmail(email, manager),
      insertAccount: (manager) =>
        this.insertRegisteredCompany(input, email, username, passwordHash, manager),
      // After commit, never inside the transaction: a rolled-back signup must not get a
      // "confirm your email" message, and a Redis outage must not fail the signup.
      sendVerification: (userId) => this.requestEmailVerification(userId, context),
      notifyExistingAccount: (account) => this.notifyRegistrationAttempt(account),
      logError: (err, message) => logger.error({ err }, message),
    });
  }

  private async insertRegisteredCompany(
    input: RegisterCompanyInput,
    email: string,
    username: string,
    passwordHash: string,
    manager: EntityManager,
  ): Promise<{ userId: string }> {
    const now = new Date();

    const user = await this.userRepository.create(
      {
        email,
        username,
        password: passwordHash,
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
        promoEmailOptIn: input.promoEmailOptIn,
        termsAcceptedAt: now,
        isActive: false,
        joinedAt: now,
        qrToken: generateRandomToken(24),
      },
      manager,
    );

    logger.info(
      { userId: user.id, companyId: company.id },
      "Company registered (pending activation)",
    );

    // No session is issued and no trial-eligibility hint is returned: either would
    // make this answer differ from the taken-email one. The trial is still decided
    // (and the identifiers claimed) at verification — see confirmEmailVerification.
    return { userId: user.id };
  }

  /**
   * Someone submitted the registration form with this account's login email. Tell the
   * owner, at most once an hour per address (sendRegistrationAttemptNotice).
   *
   * Enqueued straight onto the shared queue's existing `generic` job rather than via
   * EmailService.enqueueRenderedEmail, whose log line carries the full recipient
   * address. Logs here carry the user id and the domain only.
   */
  private async notifyRegistrationAttempt(account: ExistingAccount): Promise<void> {
    const redis = getRedisClient();
    const outcome = await sendRegistrationAttemptNotice(account, {
      claimOnce: async (key, ttlSeconds) =>
        (await redis.set(key, "1", "EX", ttlSeconds, "NX")) === "OK",
      release: async (key) => {
        await redis.del(key);
      },
      enqueue: async (to, rendered) => {
        await emailQueue.add(
          "generic",
          {
            type: "generic",
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          },
          // No colons (see EmailService.enqueuePasswordReset); the user id, not the address.
          { jobId: `regattempt-${account.id}-${Date.now()}` },
        );
      },
      frontendBaseUrl: config.FRONTEND_BASE_URL,
    });
    logger.info(
      { userId: account.id, emailDomain: emailDomainForLog(account.email), outcome },
      "Registration attempted with an existing login email",
    );
  }

  async login(input: LoginInput, context: LoginContext): Promise<LoginResult> {
    const identifier = input.identifier.trim();
    const isEmail = identifier.includes("@");
    const normalized = isEmail ? identifier.toLowerCase() : identifier;

    const user = isEmail
      ? await this.userRepository.findByEmailWithPassword(normalized)
      : await this.findUserByUsernameWithPassword(normalized);

    // The message was already identical for all three failures, but the *timing* was
    // not: skipping bcrypt when the account doesn't exist answered in a fraction of the
    // time a real account takes, which enumerates our customer list just as effectively
    // as a different error string would.
    if (!user || !user.isActive) {
      await this.passwordService.verifyAgainstDecoy(input.password);
      throw UnauthorizedError("Invalid credentials");
    }

    const passwordOk = await this.passwordService.verify(input.password, user.password);
    if (!passwordOk) {
      throw UnauthorizedError("Invalid credentials");
    }

    let companyId: string | undefined;
    let companyIsActive: boolean | undefined;
    if (user.userType === "company") {
      const company = await this.companyRepository.findByOwnerUserId(user.id);
      if (!company) {
        throw UnauthorizedError("Invalid credentials");
      }
      // Deactivated (admin ban) — hard block, no tokens. `deactivatedAt` alone is the
      // ban; see computeEntitlement for why `isActive` is not consulted.
      if (company.deactivatedAt != null) {
        throw ForbiddenError("Your account has been deactivated. Please contact support.");
      }
      // Pending (registered, not yet subscribed) — issue tokens so they can reach /billing
      companyId = company.id;
      companyIsActive = company.isActive;
    }

    return AppDataSource.transaction(async (manager) => {
      const tokens = await this.tokenService.issueTokens(user, companyId, context, manager);
      await this.userRepository.updateLastLoginAt(user.id, new Date(), manager);

      logger.info({ userId: user.id, userType: user.userType, companyIsActive }, "User logged in");

      return {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          userType: user.userType,
          isActive: user.isActive,
        },
        ...(companyId ? { companyId } : {}),
        ...(companyIsActive !== undefined ? { companyIsActive } : {}),
        tokens,
      };
    });
  }

  async refreshTokens(input: RefreshTokenInput, context: LoginContext): Promise<RefreshResult> {
    const tokenHash = this.tokenService.hashToken(input.refreshToken);

    try {
      return await this.rotateRefreshToken(tokenHash, context);
    } catch (err) {
      if (err instanceof SessionReuseDetected) {
        // Fresh transaction — the one that detected this has already rolled back.
        await AppDataSource.transaction((manager) =>
          this.tokenRepository.revokeAllRefreshTokensForUser(err.userId, manager),
        );
        logger.warn(
          { userId: err.userId, tokenId: err.tokenId, reason: err.reason },
          "Refresh token reuse detected — all user sessions revoked",
        );
        throw UnauthorizedError("Session invalidated. Please log in again.");
      }
      throw err;
    }
  }

  private async rotateRefreshToken(
    tokenHash: string,
    context: LoginContext,
  ): Promise<RefreshResult> {
    return AppDataSource.transaction(async (manager) => {
      const tokenRow = await this.tokenRepository.findRefreshTokenByHash(tokenHash, manager);
      if (!tokenRow) {
        throw UnauthorizedError("Invalid refresh token");
      }

      if (tokenRow.revokedAt !== null) {
        throw new SessionReuseDetected(tokenRow.user.id, tokenRow.id, "reuse of a spent token");
      }

      if (tokenRow.expiresAt.getTime() <= Date.now()) {
        throw UnauthorizedError("Refresh token has expired");
      }

      const user = await this.userRepository.findById(tokenRow.user.id, manager);
      if (!user || !user.isActive) {
        throw UnauthorizedError("User account is not available");
      }

      // Whoever wins this UPDATE owns the rotation. A loser means another request
      // already consumed this exact token — indistinguishable from reuse, and the
      // check above cannot catch it because both requests read `revoked_at IS NULL`
      // before either wrote. Without this, the loser was still issued a full token
      // pair, which is precisely the theft scenario rotation exists to prevent.
      const wonRotation = await this.tokenRepository.revokeRefreshToken(tokenRow.id, manager);
      if (!wonRotation) {
        throw new SessionReuseDetected(tokenRow.user.id, tokenRow.id, "concurrent double-spend");
      }

      let companyId: string | undefined;
      let companyIsActive: boolean | undefined;
      if (user.userType === "company") {
        const company = await this.companyRepository.findByOwnerUserId(user.id, manager);
        if (!company) {
          throw UnauthorizedError("Company profile unavailable");
        }
        // Deactivated companies lose their session; pending companies keep theirs
        if (company.deactivatedAt != null) {
          throw UnauthorizedError("Company profile unavailable");
        }
        companyId = company.id;
        companyIsActive = company.isActive;
      }

      const tokens = await this.tokenService.issueTokens(user, companyId, context, manager);

      logger.info({ userId: user.id, rotatedFromTokenId: tokenRow.id }, "Refresh token rotated");

      return {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          userType: user.userType,
          isActive: user.isActive,
        },
        ...(companyId ? { companyId } : {}),
        ...(companyIsActive !== undefined ? { companyIsActive } : {}),
        tokens,
      };
    });
  }

  /**
   * @param accessToken The bearer token the request carried, if any. Revoked as well, so
   *   logging out actually ends the session instead of leaving a 24h access token live.
   *   A Redis failure here is logged, not thrown: the refresh token is still revoked
   *   below, so the session cannot be renewed, and the user must still see a logout.
   */
  async logout(refreshToken: string, accessToken?: string | null): Promise<void> {
    if (accessToken) {
      await this.tokenService.revokeAccessToken(accessToken).catch((err: unknown) => {
        logger.error({ err }, "Could not revoke the access token on logout");
      });
    }

    const tokenHash = this.tokenService.hashToken(refreshToken);
    const tokenRow = await this.tokenRepository.findRefreshTokenByHash(tokenHash);
    if (tokenRow && tokenRow.revokedAt === null) {
      await this.tokenRepository.revokeRefreshToken(tokenRow.id);
      logger.info({ userId: tokenRow.user.id, tokenId: tokenRow.id }, "User logged out");
    }
  }

  /**
   * Request a password reset. ALWAYS returns the same result shape regardless of whether
   * the email exists, to prevent enumeration. If the user exists and is active, prior
   * active reset tokens are invalidated, a fresh token is issued, and the reset email
   * is enqueued via the BullMQ email worker.
   *
   * The same TIME too. The response used to wait for the token transaction and the
   * queue write, but only for a real account — an unknown address returned after one
   * lookup, so response time told a caller which addresses had accounts even though the
   * message never did. Both paths now do the same single lookup and return; the
   * issuing happens after the response, and its failures are logged.
   */
  async requestPasswordReset(
    input: PasswordResetRequestInput,
    context: LoginContext,
  ): Promise<void> {
    const email = input.email.trim().toLowerCase();

    const user = await this.userRepository.findByEmail(email);
    if (!user || !user.isActive) {
      // The domain only. This is an unauthenticated endpoint, so logging the address
      // kept a copy of every email anyone typed in, customer or not.
      logger.info(
        { emailDomain: emailDomainForLog(email) },
        "Password reset requested for unknown/inactive email",
      );
      return;
    }

    void this.issuePasswordReset(user, context).catch((err: unknown) => {
      logger.error({ err, userId: user.id }, "Failed to issue password reset");
    });
  }

  private async issuePasswordReset(user: User, context: LoginContext): Promise<void> {
    const raw = generateRandomToken(32);
    const hash = this.tokenService.hashToken(raw);
    const ttlMs = config.PASSWORD_RESET_TTL_MIN * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    await AppDataSource.transaction(async (manager) => {
      await this.tokenRepository.invalidateActivePasswordResets(user.id, manager);
      await this.tokenRepository.create(
        {
          user,
          type: "password_reset",
          tokenHash: hash,
          expiresAt,
          ipAddress: context.ip ?? null,
          userAgent: context.userAgent ?? null,
        },
        manager,
      );
    });

    logger.info({ userId: user.id, expiresAt }, "Password reset token issued");

    try {
      await this.emailService.enqueuePasswordReset({
        to: user.email,
        resetToken: raw,
        expiresInMinutes: config.PASSWORD_RESET_TTL_MIN,
      });
    } catch (err) {
      // Never let email-queue failure leak. Log + swallow so the API still returns a
      // generic success message and the user can re-request.
      logger.error({ err, userId: user.id }, "Failed to enqueue password reset email");
    }
  }

  /**
   * Issue (or re-issue) an email-verification link.
   *
   * Returns void unconditionally and the controller always responds with the same
   * generic message — an authenticated caller already knows their own address, and
   * keeping the shape uniform means the unauthenticated resend path can share this
   * code later without becoming an enumeration oracle.
   */
  async requestEmailVerification(userId: string, context: LoginContext): Promise<void> {
    const user = await this.userRepository.findById(userId);
    if (!user?.isActive) return;
    if (user.emailVerifiedAt) {
      logger.info({ userId }, "Email verification requested but already verified");
      return;
    }

    const raw = generateRandomToken(32);
    const hash = this.tokenService.hashToken(raw);
    const ttlMs = config.EMAIL_VERIFICATION_TTL_MIN * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    await AppDataSource.transaction(async (manager) => {
      // Consume any outstanding link first — the partial unique index permits only
      // one live token per user, so a resend must retire the previous one.
      await this.tokenRepository.invalidateActiveEmailVerifications(user.id, manager);
      await this.tokenRepository.create(
        {
          user,
          type: "email_verification",
          tokenHash: hash,
          expiresAt,
          ipAddress: context.ip ?? null,
          userAgent: context.userAgent ?? null,
        },
        manager,
      );
    });

    logger.info({ userId: user.id, expiresAt }, "Email verification token issued");

    try {
      await this.emailService.enqueueEmailVerification({
        to: user.email,
        verificationToken: raw,
        expiresInMinutes: config.EMAIL_VERIFICATION_TTL_MIN,
      });
    } catch (err) {
      // Same posture as password reset: a queue outage must not fail the request.
      logger.error({ err, userId: user.id }, "Failed to enqueue verification email");
    }
  }

  /**
   * Consume a verification link and stamp `users.email_verified_at`.
   *
   * Deliberately idempotent-friendly: re-clicking a consumed link fails closed with
   * the same message as an invalid one, but an already-verified user hitting a fresh
   * link is a no-op rather than an error.
   *
   * The trial clock is started by the caller (Phase 3), not here — this method's only
   * job is to establish that the address is real.
   */
  async confirmEmailVerification(token: string): Promise<{ userId: string; email: string }> {
    // Decided inside the transaction, acted on after it commits: the QR email must never
    // go out for a verification that then rolled back.
    let qrCompanyId = null as string | null;
    const result = await AppDataSource.transaction(async (manager) => {
      const tokenHash = this.tokenService.hashToken(token);
      const tokenRow = await this.tokenRepository.findUsableEmailVerificationToken(
        tokenHash,
        manager,
      );
      if (!tokenRow) {
        throw UnauthorizedError("This verification link is invalid or has expired.");
      }

      const user = await this.userRepository.findById(tokenRow.user.id, manager);
      if (!user?.isActive) {
        throw UnauthorizedError("User account is not available");
      }

      await this.tokenRepository.consumeEmailVerificationToken(tokenRow.id, manager);

      if (!user.emailVerifiedAt) {
        await this.userRepository.markEmailVerified(user.id, manager);
        logger.info({ userId: user.id }, "Email verified");

        // Start the free trial.
        //
        // The verification email states "your trial clock only starts once you
        // confirm" — and nothing was writing these columns, so every new customer
        // confirmed, was told their trial had begun, and landed on a paywall.
        // `computeEntitlement` already handles the `trialing` state; only the stamp
        // was missing.
        //
        // Guarded so it can only ever happen once per company, and never to someone
        // who has already paid.
        if (user.userType === "company") {
          const company = await this.companyRepository.findByOwnerUserId(user.id, manager);
          // The QR code goes out on first verification whether or not a trial starts:
          // a company without a trial still needs the code to print once it pays.
          if (company && company.deactivatedAt == null) qrCompanyId = company.id;
          // Never on a banned company. Starting a trial writes `isActive: true`, which
          // was one of the paths that lifted a ban without an admin. Checked before
          // the identity claim too, so a banned account does not burn the identifiers.
          if (
            company &&
            company.deactivatedAt == null &&
            company.trialStartedAt === null &&
            company.subscriptionExpiresAt === null
          ) {
            // One trial per email address and per phone number, ever, across all
            // companies. The claim happens HERE rather than at registration because
            // this is the first point at which control of the address is proven —
            // claiming at registration would let anyone burn a stranger's trial by
            // typing their address into a form they never confirm.
            const mayTrial = await this.trialIdentityService.claimForTrial(
              {
                loginEmail: user.email,
                contactEmail: company.contactEmail,
                contactPhone: company.contactPhone,
              },
              company.id,
              manager,
            );

            if (mayTrial) {
              const days = await this.settingsService.getTrialDurationDays(manager);
              const now = new Date();
              const trialEndsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
              await manager.getRepository(Company).update(company.id, {
                trialStartedAt: now,
                trialEndsAt,
                // Required for the QR form to accept scans during the trial —
                // `QrService.submitPurchase` gates on the same entitlement.
                isActive: true,
                subscriptionStatus: "trialing",
              });
              logger.info({ companyId: company.id, days, trialEndsAt }, "Free trial started");
            }
            // No else: the company stays `pending`, which `computeEntitlement`
            // already renders as the paywall. Registration is never blocked by a
            // repeat identifier — only the free trial is.
          }
        }
      }

      return { userId: user.id, email: user.email };
    });

    // Not awaited, and cannot throw: an email problem must not fail the verification.
    if (qrCompanyId) void this.notificationService.sendQrCode(qrCompanyId);
    return result;
  }

  async changePassword(userId: string, input: PasswordChangeInput): Promise<void> {
    const user = await this.userRepository.findByIdWithPassword(userId);
    if (!user?.isActive) {
      throw UnauthorizedError("User account is not available");
    }

    const currentOk = await this.passwordService.verify(input.currentPassword, user.password);
    if (!currentOk) {
      throw BadRequestError("Current password is incorrect");
    }

    const newHash = await this.passwordService.hash(input.newPassword);

    await AppDataSource.transaction(async (manager) => {
      await this.userRepository.updatePasswordChanged(user.id, newHash, manager);
      await this.tokenRepository.revokeAllRefreshTokensForUser(user.id, manager);
    });

    logger.info({ userId: user.id }, "Password changed; all sessions revoked");
  }

  async confirmPasswordReset(input: PasswordResetConfirmInput): Promise<void> {
    const tokenHash = this.tokenService.hashToken(input.token);
    let qrCompanyId = null as string | null;

    await AppDataSource.transaction(async (manager) => {
      const tokenRow = await this.tokenRepository.findUsablePasswordResetToken(tokenHash, manager);
      if (!tokenRow) {
        throw UnauthorizedError("Reset token is invalid or has expired");
      }

      const user = await this.userRepository.findById(tokenRow.user.id, manager);
      if (!user || !user.isActive) {
        throw UnauthorizedError("User account is not available");
      }

      const newHash = await this.passwordService.hash(input.newPassword);
      await this.userRepository.updatePasswordChanged(user.id, newHash, manager);

      // Setting a password from an emailed link proves control of the mailbox, which is
      // exactly what verification asks for — so an unverified account becomes verified
      // here rather than being asked to prove the same thing twice.
      //
      // This matters most for admin-onboarded companies: they arrive through this path
      // by design, and without it the dashboard would greet them with a banner urging
      // them to confirm their email "to start your free trial" — an offer that does not
      // apply to a comped account and a step they have already completed.
      if (user.emailVerifiedAt == null) {
        await this.userRepository.markEmailVerified(user.id, manager);
        // First proof of the mailbox, so the QR code goes out now: this is the
        // admin-onboarded company's equivalent of clicking the verify link.
        if (user.userType === "company") {
          const company = await this.companyRepository.findByOwnerUserId(user.id, manager);
          if (company && company.deactivatedAt == null) qrCompanyId = company.id;
        }
      }

      await this.tokenRepository.consumePasswordResetToken(tokenRow.id, manager);
      await this.tokenRepository.revokeAllRefreshTokensForUser(user.id, manager);

      logger.info(
        { userId: user.id, tokenId: tokenRow.id },
        "Password reset confirmed; all sessions revoked",
      );
    });

    if (qrCompanyId) void this.notificationService.sendQrCode(qrCompanyId);
  }

  private async findUserByUsernameWithPassword(username: string) {
    return this.userRepository.findByUsernameWithPassword(username);
  }

  /**
   * Username and registration number only. The login email is deliberately NOT checked
   * here: a taken address is answered with the neutral success response, never with an
   * error (registerCompany / runRegistration).
   */
  private async assertOtherIdentifiersFree(
    username: string,
    registrationNumber: string,
    manager?: EntityManager,
  ): Promise<void> {
    const [usernameTaken, regTaken] = await Promise.all([
      this.userRepository.findByUsername(username, manager),
      this.companyRepository.findByRegistrationNumber(registrationNumber, manager),
    ]);

    const details = [];
    if (usernameTaken)
      details.push({
        field: "username",
        message: "This username is already taken. Please choose a different one.",
      });
    if (regTaken)
      details.push({
        field: "registrationNumber",
        message: "This registration number is already in use by another company.",
      });

    if (details.length > 0) {
      throw ConflictError(
        "Some of your details are already in use. Please review the highlighted fields and try again.",
        details,
      );
    }
  }
}
