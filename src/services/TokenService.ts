import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { EntityManager } from "typeorm";
import { config } from "@/config/index";
import type { User, UserType } from "@/entities/User";
import { TokenRepository } from "@/repositories/TokenRepository";
import { UnauthorizedError } from "@/errors/index";

export interface AccessTokenPayload {
  sub: string;
  userType: UserType;
  companyId?: string;
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
  private tokenRepository = new TokenRepository();

  signAccessToken(user: User, companyId?: string): { token: string; expiresAt: Date } {
    const payload: AccessTokenPayload = {
      sub: user.id,
      userType: user.userType,
    };
    if (companyId !== undefined) payload.companyId = companyId;
    const token = jwt.sign(payload, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
    } as SignOptions);
    const decoded = jwt.decode(token) as { exp: number };
    return { token, expiresAt: new Date(decoded.exp * 1000) };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      return jwt.verify(token, config.JWT_SECRET) as AccessTokenPayload;
    } catch {
      throw UnauthorizedError("Invalid or expired access token");
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
