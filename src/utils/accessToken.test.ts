import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  LEGACY_UNSCOPED_ISSUED_BEFORE,
  remainingLifetimeSeconds,
  revokedAccessTokenKey,
  signAccessJwt,
  verifyAccessJwt,
} from "@/utils/accessToken";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const payload = { sub: "user-1", userType: "company" as const, companyId: "co-1" };

describe("access token signing", () => {
  it("signs with HS256 and the pinned issuer and audience", () => {
    const token = signAccessJwt(payload, SECRET, "24h");
    const header = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()) as {
      alg: string;
    };
    assert.equal(header.alg, "HS256");
    const claims = jwt.decode(token) as Record<string, unknown>;
    assert.equal(claims["iss"], JWT_ISSUER);
    assert.equal(claims["aud"], JWT_AUDIENCE);
    assert.equal(verifyAccessJwt(token, SECRET).sub, "user-1");
  });
});

describe("access token verification", () => {
  it("refuses alg=none", () => {
    const unsigned = jwt.sign({ ...payload, iss: JWT_ISSUER, aud: JWT_AUDIENCE }, "", {
      algorithm: "none",
    });
    assert.throws(() => verifyAccessJwt(unsigned, SECRET));
  });

  it("refuses a different HMAC algorithm even with the right secret", () => {
    const hs512 = jwt.sign(payload, SECRET, {
      algorithm: "HS512",
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    assert.throws(() => verifyAccessJwt(hs512, SECRET));
  });

  it("refuses the wrong issuer or audience", () => {
    const wrongAud = jwt.sign(payload, SECRET, { issuer: JWT_ISSUER, audience: "other-app" });
    const wrongIss = jwt.sign(payload, SECRET, { issuer: "someone-else", audience: JWT_AUDIENCE });
    const onlyIss = jwt.sign(payload, SECRET, { issuer: JWT_ISSUER });
    assert.throws(() => verifyAccessJwt(wrongAud, SECRET));
    assert.throws(() => verifyAccessJwt(wrongIss, SECRET));
    assert.throws(() => verifyAccessJwt(onlyIss, SECRET));
  });

  it("refuses a bad signature and an expired token", () => {
    assert.throws(() =>
      verifyAccessJwt(signAccessJwt(payload, "another-secret-32-characters-long!!", "1h"), SECRET),
    );
    const token = signAccessJwt(payload, SECRET, "1h");
    assert.throws(() => verifyAccessJwt(token, SECRET, new Date(Date.now() + 2 * 60 * 60 * 1000)));
  });

  it("still accepts a pre-deploy token without iss/aud, so nobody is bounced on deploy", () => {
    const iat = Math.floor(LEGACY_UNSCOPED_ISSUED_BEFORE.getTime() / 1000) - 3600;
    const legacy = jwt.sign({ ...payload, iat, exp: iat + 24 * 3600 }, SECRET);
    const now = new Date((iat + 60) * 1000);
    assert.equal(verifyAccessJwt(legacy, SECRET, now).sub, "user-1");
  });

  it("refuses a token without iss/aud issued after the transition cut-off", () => {
    const iat = Math.floor(LEGACY_UNSCOPED_ISSUED_BEFORE.getTime() / 1000) + 60;
    const forged = jwt.sign({ ...payload, iat, exp: iat + 3600 }, SECRET);
    assert.throws(() => verifyAccessJwt(forged, SECRET, new Date((iat + 10) * 1000)));
  });

  it("refuses a token with no subject", () => {
    const token = jwt.sign({ userType: "company" }, SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    assert.throws(() => verifyAccessJwt(token, SECRET));
  });
});

describe("access token revocation helpers", () => {
  it("keys revocation on a hash, never the token itself", () => {
    const token = signAccessJwt(payload, SECRET, "1h");
    const key = revokedAccessTokenKey(token);
    assert.equal(key, revokedAccessTokenKey(token));
    assert.ok(!key.includes(token.split(".")[2]!));
    assert.match(key, /^auth:revoked-access:[0-9a-f]{64}$/);
  });

  it("keeps the entry only as long as the token could still be used", () => {
    const now = new Date("2026-09-13T12:00:00Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    assert.equal(remainingLifetimeSeconds(nowSec + 90, now), 90);
    assert.equal(remainingLifetimeSeconds(nowSec - 5, now), 0);
    assert.equal(remainingLifetimeSeconds(undefined, now), 0);
  });
});
