import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compSpinWindowStart } from "@/services/AdminCompService";

const NOW = new Date("2026-10-03T12:00:00Z");
const OLD_GRANT = new Date("2026-09-20T10:00:00Z");
const base = {
  isComped: true,
  compedUntil: new Date("2026-10-14T00:00:00Z"),
  compDrawSpins: 15,
  compDrawSpinsGrantedAt: OLD_GRANT,
};

describe("compSpinWindowStart", () => {
  it("keeps the window when a running comp's spins are topped up", () => {
    assert.equal(compSpinWindowStart(base, 20, NOW), OLD_GRANT);
  });

  it("keeps the window for a running comp with no end date", () => {
    assert.equal(compSpinWindowStart({ ...base, compedUntil: null }, 20, NOW), OLD_GRANT);
  });

  it("opens a fresh window when the earlier comp has lapsed (the bug: it reused the old one)", () => {
    const lapsed = { ...base, compedUntil: new Date("2026-09-27T23:59:59Z") };
    assert.equal(compSpinWindowStart(lapsed, 10, NOW), NOW);
  });

  it("opens a fresh window for a first grant or after a revoke", () => {
    assert.equal(compSpinWindowStart({ ...base, isComped: false }, 10, NOW), NOW);
    assert.equal(
      compSpinWindowStart({ ...base, compDrawSpins: 0, compDrawSpinsGrantedAt: null }, 10, NOW),
      NOW,
    );
  });

  it("no spins means no window", () => {
    assert.equal(compSpinWindowStart(base, 0, NOW), null);
  });
});
