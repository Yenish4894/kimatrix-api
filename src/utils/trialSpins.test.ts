import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trialSpinsFor } from "@/utils/spinAddon";
import { computeEntitlement } from "@/utils/entitlement";

describe("trialSpinsFor", () => {
  it("gives a company on trial the admin's configured spins", () => {
    assert.equal(trialSpinsFor(true, 5), 5);
  });

  it("gives nothing when the trial isn't what grants access", () => {
    assert.equal(trialSpinsFor(false, 5), 0);
  });

  it("gives nothing when the admin set 0, and never a negative or fractional count", () => {
    assert.equal(trialSpinsFor(true, 0), 0);
    assert.equal(trialSpinsFor(true, -3), 0);
    assert.equal(trialSpinsFor(true, 2.7), 2);
    assert.equal(trialSpinsFor(true, Number.NaN), 0);
  });
});

describe("who counts as on trial for spins", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const base = {
    isActive: true,
    deactivatedAt: null,
    isComped: false,
    compedUntil: null,
    subscriptionExpiresAt: null,
    trialStartedAt: new Date("2026-09-10T00:00:00Z"),
    trialEndsAt: new Date("2026-09-17T00:00:00Z"),
  };

  it("a company inside its trial window gets trial spins", () => {
    const e = computeEntitlement(base as never, now);
    assert.equal(trialSpinsFor(e.isTrial, 3), 3);
  });

  it("a company that paid during its trial does not collect trial spins too", () => {
    const e = computeEntitlement(
      { ...base, subscriptionExpiresAt: new Date("2026-10-10T00:00:00Z") } as never,
      now,
    );
    assert.equal(trialSpinsFor(e.isTrial, 3), 0);
  });

  it("a company whose trial has ended gets none", () => {
    const e = computeEntitlement(
      { ...base, trialEndsAt: new Date("2026-09-12T00:00:00Z") } as never,
      now,
    );
    assert.equal(trialSpinsFor(e.isTrial, 3), 0);
  });
});
