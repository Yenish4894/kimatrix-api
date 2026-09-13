import type { EntityManager } from "typeorm";

/** The user row as the email-change confirm step reads it, under lock. */
export interface EmailChangeUserRow {
  id: string;
  email: string;
  is_active: boolean;
  email_verified_at: Date | null;
  user_type: "company" | "super_admin";
}

/**
 * `email_change_tokens` and the `users` writes of the change-login-email flow. Every
 * method runs in the caller's transaction. See EmailChangeService for the flow.
 */
export class EmailChangeRepository {
  /** Row-locks the user, serialising two requests from the same user. */
  async lockUser(userId: string, manager: EntityManager): Promise<void> {
    await manager.query(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, [userId]);
  }

  /** Retires every unused link of the user, so only the newest one works. */
  async retireActiveTokens(userId: string, manager: EntityManager): Promise<void> {
    await manager.query(
      `UPDATE "email_change_tokens" SET "used_at" = now()
          WHERE "user_id" = $1 AND "used_at" IS NULL`,
      [userId],
    );
  }

  async insertToken(
    data: { userId: string; newEmail: string; tokenHash: string; expiresAt: Date },
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "email_change_tokens" ("user_id", "new_email", "token_hash", "expires_at")
         VALUES ($1, $2, $3, $4)`,
      [data.userId, data.newEmail, data.tokenHash, data.expiresAt],
    );
  }

  /** Locks the unused, unexpired token with this hash. */
  async findUsableTokenForUpdate(
    tokenHash: string,
    manager: EntityManager,
  ): Promise<{ id: string; user_id: string; new_email: string } | undefined> {
    const [row] = (await manager.query(
      `SELECT t."id", t."user_id", t."new_email"
           FROM "email_change_tokens" t
          WHERE t."token_hash" = $1 AND t."used_at" IS NULL AND t."expires_at" > now()
          FOR UPDATE`,
      [tokenHash],
    )) as { id: string; user_id: string; new_email: string }[];
    return row;
  }

  /** Locks the (not soft-deleted) user. */
  async findUserForUpdate(
    userId: string,
    manager: EntityManager,
  ): Promise<EmailChangeUserRow | undefined> {
    const [user] = (await manager.query(
      `SELECT u."id", u."email", u."is_active", u."email_verified_at", u."user_type"
           FROM "users" u
          WHERE u."id" = $1 AND u."deleted_at" IS NULL
          FOR UPDATE`,
      [userId],
    )) as EmailChangeUserRow[];
    return user;
  }

  /** Whether another user already has this email. */
  async isEmailTakenByOther(
    email: string,
    userId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const [clash] = (await manager.query(
      `SELECT 1 AS x FROM "users" WHERE "email" = $1 AND "id" <> $2 LIMIT 1`,
      [email, userId],
    )) as unknown[];
    return Boolean(clash);
  }

  /**
   * Switches the login email; stamps `email_verified_at` only when `markVerified`.
   * Throws the driver error as-is (23505 on a unique clash) for the caller to map.
   */
  async updateLoginEmail(
    userId: string,
    newEmail: string,
    markVerified: boolean,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `UPDATE "users"
              SET "email" = $2,
                  "email_verified_at" = CASE WHEN $3::boolean THEN now() ELSE "email_verified_at" END,
                  "updated_at" = now()
            WHERE "id" = $1`,
      [userId, newEmail, markVerified],
    );
  }
}
