import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import type { User } from "@/entities/User";
import type { Company } from "@/entities/Company";
import { UserRepository } from "@/repositories/UserRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { EmailService } from "@/services/EmailService";
import { PasswordService } from "@/services/PasswordService";
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
  tokens: IssuedTokens;
}

export interface RefreshResult {
  user: Pick<User, "id" | "email" | "username" | "userType" | "isActive">;
  companyId?: string;
  companyIsActive?: boolean;
  tokens: IssuedTokens;
}

export class AuthService {
  private userRepository = new UserRepository();
  private companyRepository = new CompanyRepository();
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
        tokens,
      };
    };

    if (outerManager) return run(outerManager);
    return AppDataSource.transaction(run);
  }

  async login(input: LoginInput, context: LoginContext): Promise<LoginResult> {
    const identifier = input.identifier.trim();
    const isEmail = identifier.includes("@");
    const normalized = isEmail ? identifier.toLowerCase() : identifier;

    const user = isEmail
      ? await this.userRepository.findByEmailWithPassword(normalized)
      : await this.findUserByUsernameWithPassword(normalized);

    if (!user) {
      throw UnauthorizedError("Invalid credentials");
    }
    if (!user.isActive) {
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

    return AppDataSource.transaction(async (manager) => {
      const tokenRow = await this.tokenRepository.findRefreshTokenByHash(tokenHash, manager);
      if (!tokenRow) {
        throw UnauthorizedError("Invalid refresh token");
      }

      if (tokenRow.revokedAt !== null) {
        await this.tokenRepository.revokeAllRefreshTokensForUser(tokenRow.user.id, manager);
        logger.warn(
          { userId: tokenRow.user.id, tokenId: tokenRow.id },
          "Refresh token reuse detected — all user sessions revoked",
        );
        throw UnauthorizedError("Session invalidated. Please log in again.");
      }

      if (tokenRow.expiresAt.getTime() <= Date.now()) {
        throw UnauthorizedError("Refresh token has expired");
      }

      const user = await this.userRepository.findById(tokenRow.user.id, manager);
      if (!user || !user.isActive) {
        throw UnauthorizedError("User account is not available");
      }

      await this.tokenRepository.revokeRefreshToken(tokenRow.id, manager);

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
