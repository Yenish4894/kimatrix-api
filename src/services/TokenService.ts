import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { EntityManager } from "typeorm";
import { config } from "@/config/index";
import { getRedisClient } from "@/config/redis.client";
import type { User } from "@/entities/User";
import { TokenRepository } from "@/repositories/TokenRepository";
import { UnauthorizedError } from "@/errors/index";
import { logger } from "@/utils/logger";
import {
  remainingLifetimeSeconds,
  revokedAccessTokenKey,
  signAccessJwt,
  verifyAccessJwt,
  type AccessTokenPayload,
} from "@/utils/accessToken";

export type { AccessTokenPayload } from "@/utils/accessToken";

/**
 * How long a request waits on Redis for the revocation check before giving up. The
 * check runs on EVERY authenticated request, and ioredis queues commands while
 * reconnecting, so without a bound a Redis outage would add its full retry delay to
 * every page load.
 */
const REVOCATION_CHECK_TIMEOUT_MS = 250;
const REVOCATION_WARN_INTERVAL_MS = 60_000;
let lastRevocationWarnAt = 0;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface IssueTokenContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

const REFRESH_TOKEN_BYTES = 48;

export class TokenService {
  constructor(private readonly tokenRepository = new TokenRepository()) {}

  signAccessToken(user: User, companyId?: string): { token: string; expiresAt: Date } {
    const payload: Pick<AccessTokenPayload, "sub" | "userType" | "companyId"> = {
      sub: user.id,
      userType: user.userType,
    };
    if (companyId !== undefined) payload.companyId = companyId;
    // Algorithm, issuer and audience are pinned in utils/accessToken.
    const token = signAccessJwt(payload, config.JWT_SECRET, config.JWT_EXPIRES_IN);
    const decoded = jwt.decode(token) as { exp: number };
    return { token, expiresAt: new Date(decoded.exp * 1000) };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      return verifyAccessJwt(token, config.JWT_SECRET);
    } catch {
      throw UnauthorizedError("Invalid or expired access token");
    }
  }

  /**
   * Ends one access token before its natural expiry — what logout needs.
   *
   * Logout used to revoke only the refresh token, so the 24h access token kept working:
   * "log out" on a shared or stolen device changed nothing for a day. The token is
   * recorded in Redis for exactly its remaining lifetime, so the denylist never grows
   * past the tokens that could still be used. A token that fails verification is
   * ignored — it is already useless.
   *
   * Throws if Redis is unavailable; the caller decides whether that fails the request.
   */
  async revokeAccessToken(token: string): Promise<void> {
    let payload: AccessTokenPayload;
    try {
      payload = verifyAccessJwt(token, config.JWT_SECRET);
    } catch {
      return;
    }
    const ttl = remainingLifetimeSeconds(payload.exp);
    if (ttl <= 0) return;
    await getRedisClient().set(revokedAccessTokenKey(token), "1", "EX", ttl);
  }

  /**
   * Whether this access token was logged out.
   *
   * Fails OPEN when Redis is slow or down — the token is treated as not revoked. The
   * same choice the rate limiters make: a cache outage must not sign every user out of
   * the whole platform. The cost is that a logged-out token works again for the length
   * of the outage; password change and bans are enforced from the database and are not
   * affected.
   */
  async isAccessTokenRevoked(token: string): Promise<boolean> {
    try {
      const hits = await withTimeout(
        getRedisClient().exists(revokedAccessTokenKey(token)),
        REVOCATION_CHECK_TIMEOUT_MS,
      );
      return hits > 0;
    } catch (err) {
      if (Date.now() - lastRevocationWarnAt > REVOCATION_WARN_INTERVAL_MS) {
        lastRevocationWarnAt = Date.now();
        logger.warn({ err }, "Access-token revocation check unavailable — allowing tokens");
      }
      return false;
    }
  }

  generateRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
    const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const hash = this.hashToken(raw);
    const ttlSeconds = this.parseDurationSeconds(config.JWT_REFRESH_EXPIRES_IN);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return { raw, hash, expiresAt };
  }

  hashToken(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  async issueTokens(
    user: User,
    companyId: string | undefined,
    context: IssueTokenContext,
    manager?: EntityManager,
  ): Promise<IssuedTokens> {
    const access = this.signAccessToken(user, companyId);
    const refresh = this.generateRefreshToken();

    await this.tokenRepository.create(
      {
        user,
        type: "refresh",
        tokenHash: refresh.hash,
        expiresAt: refresh.expiresAt,
        ipAddress: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      manager,
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.raw,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  private parseDurationSeconds(input: string): number {
    const match = /^(\d+)([smhd])$/.exec(input.trim());
    if (!match) return 7 * 24 * 60 * 60;
    const [, amountRaw, unit] = match;
    const amount = Number.parseInt(amountRaw ?? "0", 10);
    switch (unit) {
      case "s":
        return amount;
      case "m":
        return amount * 60;
      case "h":
        return amount * 60 * 60;
      case "d":
        return amount * 24 * 60 * 60;
      default:
        return 7 * 24 * 60 * 60;
    }
  }
}
