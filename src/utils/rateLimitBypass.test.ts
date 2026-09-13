import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";
import { JWT_AUDIENCE, JWT_ISSUER, signAccessJwt } from "@/utils/accessToken";
import { hasVerifiedSuperAdminToken } from "@/utils/rateLimitBypass";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const admin = { sub: "admin-1", userType: "super_admin" as const };
const bearer = (token: string) => `Bearer ${token}`;

describe("hasVerifiedSuperAdminToken", () => {
  it("exempts a valid super_admin access token", () => {
    assert.equal(
      hasVerifiedSuperAdminToken(bearer(signAccessJwt(admin, SECRET, "1h")), SECRET),
      true,
    );
  });

  it("accepts the scheme case-insensitively", () => {
    const token = signAccessJwt(admin, SECRET, "1h");
    assert.equal(hasVerifiedSuperAdminToken(`bearer ${token}`, SECRET), true);
  });

  it("does not exempt a valid company token", () => {
    const token = signAccessJwt(
      { sub: "u-1", userType: "company", companyId: "co-1" },
      SECRET,
      "1h",
    );
    assert.equal(hasVerifiedSuperAdminToken(bearer(token), SECRET), false);
  });

  it("does not exempt a super_admin claim signed with another secret", () => {
    const forged = signAccessJwt(admin, "some-other-secret-that-is-32-characters!!", "1h");
    assert.equal(hasVerifiedSuperAdminToken(bearer(forged), SECRET), false);
  });

  it("does not exempt an unsigned (alg=none) super_admin claim", () => {
    const unsigned = jwt.sign({ ...admin, iss: JWT_ISSUER, aud: JWT_AUDIENCE }, "", {
      algorithm: "none",
    });
    assert.equal(hasVerifiedSuperAdminToken(bearer(unsigned), SECRET), false);
  });

  it("does not exempt an expired super_admin token", () => {
    const token = signAccessJwt(admin, SECRET, "1h");
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    assert.equal(hasVerifiedSuperAdminToken(bearer(token), SECRET, later), false);
  });

  it("does not exempt a token with the wrong audience", () => {
    const token = jwt.sign(admin, SECRET, {
      algorithm: "HS256",
      issuer: JWT_ISSUER,
      audience: "elsewhere",
      expiresIn: "1h",
    });
    assert.equal(hasVerifiedSuperAdminToken(bearer(token), SECRET), false);
  });

  it("does not exempt missing, malformed or non-bearer headers", () => {
    const token = signAccessJwt(admin, SECRET, "1h");
    assert.equal(hasVerifiedSuperAdminToken(undefined, SECRET), false);
    assert.equal(hasVerifiedSuperAdminToken("", SECRET), false);
    assert.equal(hasVerifiedSuperAdminToken("Bearer", SECRET), false);
    assert.equal(hasVerifiedSuperAdminToken("Bearer not.a.jwt", SECRET), false);
    assert.equal(hasVerifiedSuperAdminToken(`Basic ${token}`, SECRET), false);
    assert.equal(hasVerifiedSuperAdminToken([bearer(token)], SECRET), false);
  });

  it("never exempts anything when no secret is configured", () => {
    assert.equal(hasVerifiedSuperAdminToken(bearer(signAccessJwt(admin, SECRET, "1h")), ""), false);
  });
});
