import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import type { User } from "@/entities/User";
import { Company } from "@/entities/Company";
import { UserRepository } from "@/repositories/UserRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { EmailService } from "@/services/EmailService";
import { PasswordService } from "@/services/PasswordService";
import { SettingsService } from "@/services/SettingsService";
import { TrialIdentityService } from "@/services/TrialIdentityService";
import { TokenService, type IssuedTokens } from "@/services/TokenService";
import { config } from "@/config/index";
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from "@/errors/index";
import { logger } from "@/utils/logger";
import { generateRandomToken } from "@/utils/crypto";
import { TokenRepository } from "@/repositories/TokenRepository";
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

export interface RegisterCompanyResult {
  user: Pick<User, "id" | "email" | "username" | "userType" | "isActive">;
  company: Pick<
    Company,
    | "id"
    | "name"
    | "streetAddress"
    | "city"
    | "state"
    | "country"
    | "postalCode"
    | "registrationNumber"
    | "contactEmail"
    | "contactPhone"
    | "whatsappNumber"
    | "businessType"
    | "promoEmailOptIn"
    | "isActive"
    | "joinedAt"
    | "qrToken"
  >;
  companyId: string;
  companyIsActive: boolean;
  /** False until the verification link is clicked. The trial clock starts on verify. */
  emailVerified: boolean;
  trial: {
    /**
     * Advisory. The authoritative decision is made when the verification link is
     * clicked, so this can go from true to false if another registration claims the
     * same identifier in between.
     *
     * Deliberately does NOT say which identifier matched — this is an
     * unauthenticated endpoint, and naming the field would turn it into an
     * enumeration oracle over every email and phone number we hold.
     */
    eligible: boolean;
    durationDays: number;
  };
  tokens: IssuedTokens;
}

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

  async registerCompany(
    input: RegisterCompanyInput,
    context: RegisterCompanyContext,
    outerManager?: EntityManager,
  ): Promise<RegisterCompanyResult> {
    const email = input.email.trim().toLowerCase();
    const username = input.username.trim();

    const passwordHash = await this.passwordService.hash(input.password);

    const run = async (manager: EntityManager): Promise<RegisterCompanyResult> => {
      await this.assertUniqueIdentifiers(email, username, input.registrationNumber, manager);
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

      // Auto-login: issue a session so the user can immediately start the
      // subscription payment in the same flow (no separate manual login step).
      const tokens = await this.tokenService.issueTokens(user, company.id, context, manager);

      // Read-only probe so the success screen can say "your 7-day trial starts when
      // you confirm your email" rather than promising something we will refuse. The
      // identifiers are NOT claimed here — see confirmEmailVerification.
      const trialEligible = await this.trialIdentityService.isEligible(
        {
          loginEmail: email,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
        },
        manager,
      );
      const trialDurationDays = await this.settingsService.getTrialDurationDays(manager);

      return {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          userType: user.userType,
          isActive: user.isActive,
        },
        company: {
          id: company.id,
          name: company.name,
          streetAddress: company.streetAddress,
          city: company.city,
          state: company.state,
          country: company.country,
          postalCode: company.postalCode,
          registrationNumber: company.registrationNumber,
          contactEmail: company.contactEmail,
          contactPhone: company.contactPhone,
          whatsappNumber: company.whatsappNumber,
          businessType: company.businessType,
          promoEmailOptIn: company.promoEmailOptIn,
          isActive: company.isActive,
          joinedAt: company.joinedAt,
          qrToken: company.qrToken,
        },
        companyId: company.id,
        companyIsActive: company.isActive,
        emailVerified: user.emailVerifiedAt != null,
        trial: { eligible: trialEligible, durationDays: trialDurationDays },
        tokens,
      };
    };

    // A caller supplying its own manager owns the commit, so it also owns sending the
    // verification mail — we cannot enqueue against rows it hasn't committed yet.
    if (outerManager) return run(outerManager);

    const result = await AppDataSource.transaction(run);

    // Deliberately after commit. Enqueuing inside the transaction would send a
    // "welcome, confirm your email" message for a registration that then rolled back,
    // and would let a Redis outage fail an otherwise-valid signup.
    await this.requestEmailVerification(result.user.id, context);

    return result;
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
      // Deactivated (admin-disabled after activation) — hard block, no tokens
      if (!company.isActive && company.deactivatedAt != null) {
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
        if (company.deactivatedAt != null && !company.isActive) {
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

  async logout(refreshToken: string): Promise<void> {
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
   */
  async requestPasswordReset(
    input: PasswordResetRequestInput,
    context: LoginContext,
  ): Promise<void> {
    const email = input.email.trim().toLowerCase();

    const user = await this.userRepository.findByEmail(email);
    if (!user || !user.isActive) {
      logger.info({ email }, "Password reset requested for unknown/inactive email");
      return;
    }

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
    return AppDataSource.transaction(async (manager) => {
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
          if (
            company &&
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
      await this.tokenRepository.consumePasswordResetToken(tokenRow.id, manager);
      await this.tokenRepository.revokeAllRefreshTokensForUser(user.id, manager);

      logger.info(
        { userId: user.id, tokenId: tokenRow.id },
        "Password reset confirmed; all sessions revoked",
      );
    });
  }

  private async findUserByUsernameWithPassword(username: string) {
    return this.userRepository.findByUsernameWithPassword(username);
  }

  private async assertUniqueIdentifiers(
    email: string,
    username: string,
    registrationNumber: string,
    manager?: EntityManager,
  ): Promise<void> {
    const [emailTaken, usernameTaken, regTaken] = await Promise.all([
      this.userRepository.findByEmail(email, manager),
      this.userRepository.findByUsername(username, manager),
      this.companyRepository.findByRegistrationNumber(registrationNumber, manager),
    ]);

    const details = [];
    if (emailTaken)
      details.push({
        field: "email",
        message: "This email is already registered. Try logging in instead.",
      });
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
