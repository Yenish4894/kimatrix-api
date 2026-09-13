import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { UserType } from "@/entities/User";

/**
 * Access-token signing and verification rules, kept free of I/O so they can be tested.
 *
 * Pinned rather than left to jsonwebtoken's defaults:
 *  - **Algorithm.** Verify accepts HS256 only. jsonwebtoken 9 already refuses `none`,
 *    but an unpinned verify still takes any HMAC variant and, if the key were ever an
 *    asymmetric one, the classic RS/HS confusion. Pinning makes the rule explicit.
 *  - **Issuer and audience.** A token minted by anything else that shares the secret
 *    (a script, a future service) is refused instead of being a valid session here.
 */
export const JWT_ALGORITHM = "HS256" as const;
export const JWT_ISSUER = "kimates-api";
export const JWT_AUDIENCE = "kimates-web";

/**
 * Deploy transition. Tokens issued before this release carry no `iss`/`aud`; refusing
 * them on deploy would bounce every signed-in user through a refresh at once. So a
 * token with NEITHER claim is still accepted if it was issued before this instant.
 * Access tokens live 24h, so once this date is a day past the fallback accepts
 * nothing and can be deleted. A token that has either claim must match both.
 *
 * If the deploy slips past this date the fallback simply stops applying: legacy tokens
 * are refused, and the frontend's refresh flow (refresh tokens are opaque database
 * rows, untouched by this) issues new ones — a silent re-issue, not a logout.
 */
export const LEGACY_UNSCOPED_ISSUED_BEFORE = new Date("2026-10-01T00:00:00Z");

export interface AccessTokenPayload {
  sub: string;
  userType: UserType;
  companyId?: string;
  /**
   * Issued-at, in seconds. Set by jsonwebtoken automatically on sign; declared here so
   * `authMiddleware` can compare it against `users.password_changed_at` and reject
   * tokens minted before the password was changed.
   */
  iat?: number;
  exp?: number;
}

export function signAccessJwt(
  payload: Pick<AccessTokenPayload, "sub" | "userType" | "companyId">,
  secret: string,
  expiresIn: string,
): string {
  return jwt.sign(payload, secret, {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn,
  } as SignOptions);
}

/** Throws on a bad signature, a wrong algorithm, expiry, or the wrong issuer/audience. */
export function verifyAccessJwt(
  token: string,
  secret: string,
  now = new Date(),
): AccessTokenPayload {
  const decoded = jwt.verify(token, secret, {
    algorithms: [JWT_ALGORITHM],
    clockTimestamp: Math.floor(now.getTime() / 1000),
  });
  if (typeof decoded === "string") throw new Error("Unexpected string payload");

  const scoped = decoded.iss !== undefined || decoded.aud !== undefined;
  if (scoped) {
    const audienceOk = Array.isArray(decoded.aud)
      ? decoded.aud.includes(JWT_AUDIENCE)
      : decoded.aud === JWT_AUDIENCE;
    if (decoded.iss !== JWT_ISSUER || !audienceOk) {
      throw new Error("Token issuer or audience does not match");
    }
  } else if (
    typeof decoded.iat !== "number" ||
    decoded.iat * 1000 >= LEGACY_UNSCOPED_ISSUED_BEFORE.getTime()
  ) {
    throw new Error("Token has no issuer or audience");
  }

  if (typeof decoded.sub !== "string" || decoded.sub === "") {
    throw new Error("Token has no subject");
  }
  return decoded as AccessTokenPayload;
}

/**
 * Redis key marking one access token as revoked (logged out).
 *
 * A hash of the whole token rather than a `jti`: it works for tokens already issued
 * without one, so logout is effective from the first deploy, and the key never holds a
 * usable credential.
 */
export function revokedAccessTokenKey(token: string): string {
  return `auth:revoked-access:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

/** Seconds the token has left — the TTL its revocation entry needs, and no longer. */
export function remainingLifetimeSeconds(exp: number | undefined, now = new Date()): number {
  if (typeof exp !== "number") return 0;
  return Math.max(0, exp - Math.floor(now.getTime() / 1000));
}
