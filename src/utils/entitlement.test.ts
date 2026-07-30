import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEntitlement, type EntitlementInput } from "./entitlement";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const PAST = new Date("2026-07-29T12:00:00.000Z");
const FUTURE = new Date("2026-07-31T12:00:00.000Z");

/** A company that has registered and done nothing else. */
function base(overrides: Partial<EntitlementInput> = {}): EntitlementInput {
  return {
    isActive: false,
    deactivatedAt: null,
    subscriptionExpiresAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    isComped: false,
    compedUntil: null,
    ...overrides,
  };
}

describe("computeEntitlement", () => {
  it("1. deactivated — blocks access AND export, and outranks everything else", () => {
    const e = computeEntitlement(
      base({
        isActive: false,
        deactivatedAt: PAST,
        // Even with a live paid subscription and a comp, the admin kill wins.
        subscriptionExpiresAt: FUTURE,
        isComped: true,
      }),
      NOW,
    );
    assert.equal(e.status, "deactivated");
    assert.equal(e.hasAccess, false);
    assert.equal(e.canExport, false, "deactivated is the only state that blocks export");
  });

  it("2. comped with no end date — perpetual access", () => {
    const e = computeEntitlement(base({ isActive: true, isComped: true, compedUntil: null }), NOW);
    assert.equal(e.status, "active");
    assert.equal(e.hasAccess, true);
    assert.equal(e.endsAt, null);
  });

  it("2b. comped until a future date — still active", () => {
    const e = computeEntitlement(
      base({ isActive: true, isComped: true, compedUntil: FUTURE }),
      NOW,
    );
    assert.equal(e.status, "active");
    assert.equal(e.hasAccess, true);
    assert.deepEqual(e.endsAt, FUTURE);
  });

  it("2c. comp that has lapsed falls through to the normal rules", () => {
    const e = computeEntitlement(base({ isActive: true, isComped: true, compedUntil: PAST }), NOW);
    assert.equal(e.status, "pending", "a lapsed comp must not keep granting access");
    assert.equal(e.hasAccess, false);
  });

  it("3. live paid subscription", () => {
    const e = computeEntitlement(base({ isActive: true, subscriptionExpiresAt: FUTURE }), NOW);
    assert.equal(e.status, "active");
    assert.equal(e.hasAccess, true);
    assert.equal(e.isTrial, false);
  });

  it("4. live trial", () => {
    const e = computeEntitlement(
      base({ isActive: true, trialStartedAt: PAST, trialEndsAt: FUTURE }),
      NOW,
    );
    assert.equal(e.status, "trialing");
    assert.equal(e.hasAccess, true);
    assert.equal(e.isTrial, true);
    assert.deepEqual(e.endsAt, FUTURE);
  });

  it("4b. paid outranks trial — converting mid-trial never downgrades to 'trialing'", () => {
    const laterPaid = new Date("2026-08-30T12:00:00.000Z");
    const e = computeEntitlement(
      base({
        isActive: true,
        trialStartedAt: PAST,
        trialEndsAt: FUTURE,
        subscriptionExpiresAt: laterPaid,
      }),
      NOW,
    );
    assert.equal(e.status, "active");
    assert.equal(e.isTrial, false);
    assert.deepEqual(e.endsAt, laterPaid);
  });

  it("5. lapsed paid subscription — no access, export still allowed", () => {
    const e = computeEntitlement(base({ isActive: false, subscriptionExpiresAt: PAST }), NOW);
    assert.equal(e.status, "expired");
    assert.equal(e.hasAccess, false);
    assert.equal(e.canExport, true, "they must be able to download their data and leave");
  });

  it("5b. someone who once paid reads as 'expired', not 'trial_expired'", () => {
    const e = computeEntitlement(
      base({
        isActive: false,
        trialStartedAt: PAST,
        trialEndsAt: PAST,
        subscriptionExpiresAt: PAST,
      }),
      NOW,
    );
    assert.equal(e.status, "expired");
  });

  it("6. trial over, never paid", () => {
    const e = computeEntitlement(
      base({ isActive: false, trialStartedAt: PAST, trialEndsAt: PAST }),
      NOW,
    );
    assert.equal(e.status, "trial_expired");
    assert.equal(e.hasAccess, false);
    assert.equal(e.canExport, true);
  });

  it("7. registered, no trial granted, never paid", () => {
    const e = computeEntitlement(base(), NOW);
    assert.equal(e.status, "pending");
    assert.equal(e.hasAccess, false);
    assert.equal(e.canExport, true);
  });

  it("a null expiry never means unlimited access (the bug this replaces)", () => {
    // Pre-migration, `isActive && subscriptionExpiresAt === null` was treated as an
    // admin free-override by the backend and as "locked out" by the frontend.
    // Now it means exactly one thing: nothing has ever been paid.
    const e = computeEntitlement(
      base({ isActive: true, subscriptionExpiresAt: null, isComped: false }),
      NOW,
    );
    assert.equal(e.hasAccess, false);
    assert.equal(e.status, "pending");
  });

  it("expiry is exclusive at the boundary — the exact instant of expiry is expired", () => {
    const e = computeEntitlement(base({ isActive: true, subscriptionExpiresAt: NOW }), NOW);
    assert.equal(e.hasAccess, false);
    assert.equal(e.status, "expired");
  });

  it("is pure — does not mutate its input", () => {
    const input = base({ isActive: true, subscriptionExpiresAt: FUTURE });
    const snapshot = structuredClone(input);
    computeEntitlement(input, NOW);
    assert.deepEqual(input, snapshot);
  });
});
