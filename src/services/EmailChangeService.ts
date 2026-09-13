import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { BadRequestError, ConflictError, UnauthorizedError } from "@/errors/index";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { TokenRepository } from "@/repositories/TokenRepository";
import { UserRepository } from "@/repositories/UserRepository";
import { AuditService } from "@/services/AuditService";
import { AuthService } from "@/services/AuthService";
import { EmailService } from "@/services/EmailService";
import { PasswordService } from "@/services/PasswordService";
import { TokenService } from "@/services/TokenService";
import {
  renderEmailChangeConfirmEmail,
  renderEmailChangeNoticeEmail,
} from "@/templates/emailChange.template";
import { generateRandomToken } from "@/utils/crypto";
import { assertEmailsDeliverable } from "@/utils/emailDeliverability";
import { logger } from "@/utils/logger";
import type { EmailChangeRequestInput } from "@/validation/schemas/auth.schema";

export const EMAIL_CHANGE_TTL_HOURS = 24;

const INVALID_LINK = "This link is invalid or has expired.";
/**
 * One message for "taken" whichever way it is taken. Registration already says "this
 * email already has an account", so this reveals nothing new, and it is only reachable
 * with a valid session and the account's current password.
 */
const EMAIL_UNAVAILABLE = "This email address can't be used. Please choose a different one.";

/**
 * Changing the login email of a signed-in user (company owner or super_admin).
 *
 * Two steps. The request (password re-checked) stores a hashed, single-use, 24-hour
 * token and mails a link to the NEW address; the old address gets a notice. Nothing
 * changes until the link is opened, which is the proof the new mailbox belongs to the
 * user. The confirm step switches `users.email`, signs out every session and tells the
 * old address it happened.
 *
 * Tokens live in their own table rather than `tokens` because they carry the pending
 * address, and a row in `tokens` has nowhere to put it.
 */
export class EmailChangeService {
  private userRepository = new UserRepository();
  private tokenRepository = new TokenRepository();
  private companyRepository = new CompanyRepository();
  private passwordService = new PasswordService();
  private tokenService = new TokenService();
  private emailService = new EmailService();
  private auditService = new AuditService();

  async request(userId: string, input: EmailChangeRequestInput): Promise<{ message: string }> {
    const user = await this.userRepository.findByIdWithPassword(userId);
    if (!user?.isActive) throw UnauthorizedError("User account is not available");

    const passwordOk = await this.passwordService.verify(input.currentPassword, user.password);
    if (!passwordOk) throw BadRequestError("Current password is incorrect");

    const newEmail = input.newEmail.trim().toLowerCase();
    if (newEmail === user.email.toLowerCase()) {
      throw BadRequestError("That is already your login email.");
    }
    // Before the token is minted and the confirmation link mailed: that link is the one
    // message this flow sends to the new address, and a bounce from it counts against
    // the SMTP mailbox like any other. After the password check, so this cannot be used
    // as an unauthenticated DNS oracle.
    await assertEmailsDeliverable([{ field: "newEmail", value: newEmail }]);
    const taken = await this.userRepository.findByEmail(newEmail);
    if (taken && taken.id !== user.id) throw ConflictError(EMAIL_UNAVAILABLE);

    const raw = generateRandomToken(32);
    const tokenHash = this.tokenService.hashToken(raw);
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 60 * 60 * 1000);

    await AppDataSource.transaction(async (manager) => {
      // Serialises two requests from the same user, which would otherwise collide on
      // uq_email_change_tokens_active_user and surface as a 500.
      await manager.query(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, [user.id]);
      // Only the newest link works: retire any earlier one.
      await manager.query(
        `UPDATE "email_change_tokens" SET "used_at" = now()
          WHERE "user_id" = $1 AND "used_at" IS NULL`,
        [user.id],
      );
      await manager.query(
        `INSERT INTO "email_change_tokens" ("user_id", "new_email", "token_hash", "expires_at")
         VALUES ($1, $2, $3, $4)`,
        [user.id, newEmail, tokenHash, expiresAt],
      );
      await this.auditService.record(
        {
          actorUserId: user.id,
          actorEmail: user.email,
          action: "user.email_change_request",
          entityType: "user",
          entityId: user.id,
          before: { email: user.email },
          after: { newEmail },
        },
        manager,
      );
    });

    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    const confirmUrl = `${base}/confirm-email-change?token=${encodeURIComponent(raw)}`;

    // Not swallowed: the user is waiting for this mail, and a failure they are told
    // about can simply be retried (which reissues the link).
    await this.emailService.enqueueRenderedEmail({
      to: newEmail,
      rendered: renderEmailChangeConfirmEmail({
        confirmUrl,
        newEmail,
        expiresInHours: EMAIL_CHANGE_TTL_HOURS,
      }),
      tag: "emailchg-confirm",
    });
    await this.sendQuietly(
      user.email,
      renderEmailChangeNoticeEmail({ newEmail, stage: "requested" }),
      user.id,
    );

    logger.info({ userId: user.id, expiresAt }, "Email change requested");
    return {
      message: `We've sent a confirmation link to ${newEmail}. Your login email changes once you open it.`,
    };
  }

  async confirm(token: string): Promise<{ message: string; email: string }> {
    const tokenHash = this.tokenService.hashToken(token);

    const result = await AppDataSource.transaction(async (manager) => {
      const [row] = (await manager.query(
        `SELECT t."id", t."user_id", t."new_email"
           FROM "email_change_tokens" t
          WHERE t."token_hash" = $1 AND t."used_at" IS NULL AND t."expires_at" > now()
          FOR UPDATE`,
        [tokenHash],
      )) as { id: string; user_id: string; new_email: string }[];
      if (!row) throw UnauthorizedError(INVALID_LINK);

      const [user] = (await manager.query(
        `SELECT u."id", u."email", u."is_active", u."email_verified_at", u."user_type"
           FROM "users" u
          WHERE u."id" = $1 AND u."deleted_at" IS NULL
          FOR UPDATE`,
        [row.user_id],
      )) as {
        id: string;
        email: string;
        is_active: boolean;
        email_verified_at: Date | null;
        user_type: "company" | "super_admin";
      }[];
      if (!user?.is_active) throw UnauthorizedError("User account is not available");

      // Re-checked here, inside the transaction: the address may have been registered
      // by someone else in the day since the link was sent. The unique constraint on
      // users.email is the final word; this gives the friendly message first.
      const [clash] = (await manager.query(
        `SELECT 1 AS x FROM "users" WHERE "email" = $1 AND "id" <> $2 LIMIT 1`,
        [row.new_email, user.id],
      )) as unknown[];
      if (clash) throw ConflictError(EMAIL_UNAVAILABLE);

      // Opening the link proves the new mailbox, so the account counts as verified.
      // One exception: a company owner who never verified at all and has not started a
      // trial. Their free trial starts in AuthService.confirmEmailVerification, only
      // when an unverified user verifies. Stamping the column here would skip that and
      // leave them on the paywall for good. They get a normal verification link to the
      // new address instead (sent below).
      let markVerified = true;
      if (user.email_verified_at == null && user.user_type === "company") {
        const company = await this.companyRepository.findByOwnerUserId(user.id, manager);
        if (
          company &&
          company.trialStartedAt == null &&
          company.subscriptionExpiresAt == null &&
          !company.isComped
        ) {
          markVerified = false;
        }
      }

      try {
        await manager.query(
          `UPDATE "users"
              SET "email" = $2,
                  "email_verified_at" = CASE WHEN $3::boolean THEN now() ELSE "email_verified_at" END,
                  "updated_at" = now()
            WHERE "id" = $1`,
          [user.id, row.new_email, markVerified],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw ConflictError(EMAIL_UNAVAILABLE);
        throw err;
      }

      await manager.query(
        `UPDATE "email_change_tokens" SET "used_at" = now()
          WHERE "user_id" = $1 AND "used_at" IS NULL`,
        [user.id],
      );
      // Every session ends, and so does every outstanding link that was mailed to the
      // OLD address: whoever holds that mailbox must not be able to take the account back
      // with a reset link issued before the change.
      await this.tokenRepository.revokeAllRefreshTokensForUser(user.id, manager);
      await this.tokenRepository.invalidateActivePasswordResets(user.id, manager);
      await this.tokenRepository.invalidateActiveEmailVerifications(user.id, manager);

      await this.auditService.record(
        {
          actorUserId: user.id,
          actorEmail: user.email,
          action: "user.email_change",
          entityType: "user",
          entityId: user.id,
          before: { email: user.email },
          after: { email: row.new_email, emailVerified: markVerified },
        },
        manager,
      );

      return {
        userId: user.id,
        oldEmail: user.email,
        newEmail: row.new_email,
        needsVerification: !markVerified,
      };
    });

    await this.sendQuietly(
      result.oldEmail,
      renderEmailChangeNoticeEmail({ newEmail: result.newEmail, stage: "completed" }),
      result.userId,
    );

    if (result.needsVerification) {
      // Public method, called as-is: sends the standard verification link to the new
      // address, and clicking it starts the trial. Swallows its own queue errors.
      await new AuthService().requestEmailVerification(result.userId, {
        ip: undefined,
        userAgent: undefined,
      });
    }

    logger.info({ userId: result.userId }, "Login email changed; all sessions revoked");
    return {
      message: result.needsVerification
        ? "Your login email has been changed. We've sent a verification link to the new address to start your free trial. Please sign in again."
        : "Your login email has been changed. Please sign in again.",
      email: result.newEmail,
    };
  }

  /** Notices to the old address must never fail the request that triggered them. */
  private async sendQuietly(
    to: string,
    rendered: { subject: string; html: string; text: string },
    userId: string,
  ): Promise<void> {
    try {
      await this.emailService.enqueueRenderedEmail({ to, rendered, tag: "emailchg-notice" });
    } catch (err) {
      logger.error({ err, userId }, "Failed to enqueue email-change notice");
    }
  }
}
