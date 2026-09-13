import { verifyAccessJwt } from "@/utils/accessToken";

/**
 * Whether a request's Authorization header carries a VERIFIED super_admin access token.
 *
 * Used to exempt platform admins from the anonymous global API limit (100 per 15 min
 * per IP). One admin working through the companies list — each page, detail view and
 * confirm is several requests — hit that cap in normal use, and the ban/unban PATCH
 * came back 429.
 *
 * Safety: the token is verified exactly as authMiddleware verifies it (HS256 only,
 * pinned issuer/audience, expiry, signature) — an unverified `userType` claim would let
 * anyone skip the limit by forging one. What is NOT checked here is revocation and the
 * account's active flag (both need Redis/DB): a logged-out or disabled admin's token
 * that is still unexpired skips this limiter but is refused by authMiddleware on every
 * route, so it buys unlimited 401s, nothing more. The per-route limiters (login,
 * password reset, register, QR) are separate and unaffected.
 *
 * Never throws: any parse or verification failure simply means "not exempt".
 */
export function hasVerifiedSuperAdminToken(
  authorization: string | string[] | undefined,
  secret: string,
  now: Date = new Date(),
): boolean {
  if (typeof authorization !== "string" || !secret) return false;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return false;
  try {
    return verifyAccessJwt(token, secret, now).userType === "super_admin";
  } catch {
    return false;
  }
}
