import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderAmount, spinWindowClosed } from "@/utils/spinAddon";

describe("orderAmount", () => {
  it("adds spins to the plan price without float drift", () => {
    // 29.99 + 3 is 32.989999… in floating point.
    assert.equal(orderAmount(29.99, 1, 3), 32.99);
    assert.equal(orderAmount(49.99, 3, 3), 58.99);
  });

  it("prices a standalone spin purchase", () => {
    assert.equal(orderAmount(0, 7, 3), 21);
    assert.equal(orderAmount(0, 3, 0.1), 0.3);
  });

  it("charges the plan alone when no spins are added", () => {
    assert.equal(orderAmount(29.99, 0, 3), 29.99);
  });
});

describe("spinWindowClosed", () => {
  const now = new Date("2026-09-13T12:00:00Z");

  it("allows capture while the plan window is open", () => {
    assert.equal(spinWindowClosed("2026-09-20T00:00:00Z", now), false);
  });

  it("refuses capture once the window has ended, including exactly at the end", () => {
    assert.equal(spinWindowClosed("2026-09-10T00:00:00Z", now), true);
    assert.equal(spinWindowClosed(now, now), true);
  });

  it("does not block a payment with no window", () => {
    assert.equal(spinWindowClosed(null, now), false);
  });
});
