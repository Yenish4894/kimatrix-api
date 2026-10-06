import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compSpinWindowStart } from "@/services/AdminCompService";

const NOW = new Date("2026-10-03T12:00:00Z");
const OLD_GRANT = new Date("2026-09-20T10:00:00Z");
const base = {
  isComped: true,
  compedUntil: new Date("2026-10-14T00:00:00Z"),
  compDrawSpinsGrantedAt: OLD_GRANT,
};

describe("compSpinWindowStart", () => {
  it("keeps the window when a running comp is edited (spins topped up or not)", () => {
    assert.equal(compSpinWindowStart(base, true, NOW), OLD_GRANT);
  });

  it("keeps the window for a running comp with no end date", () => {
    assert.equal(compSpinWindowStart({ ...base, compedUntil: null }, true, NOW), OLD_GRANT);
  });

  it("opens a fresh window when the earlier comp has lapsed (it used to reuse the old one)", () => {
    const lapsed = { ...base, compedUntil: new Date("2026-09-27T23:59:59Z") };
    assert.equal(compSpinWindowStart(lapsed, true, NOW), NOW);
  });

  it("opens a fresh window for a first grant, even with 0 spins (bought spins need one)", () => {
    assert.equal(compSpinWindowStart({ ...base, isComped: false }, true, NOW), NOW);
    assert.equal(compSpinWindowStart({ ...base, compDrawSpinsGrantedAt: null }, true, NOW), NOW);
  });

  it("revoking the comp clears the window", () => {
    assert.equal(compSpinWindowStart(base, false, NOW), null);
  });
});
