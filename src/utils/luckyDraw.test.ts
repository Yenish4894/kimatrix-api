import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DRAW_SEED_LIMIT, drawIndex, drawSeed } from "@/utils/luckyDraw";

describe("lucky draw seed", () => {
  it("is a non-negative integer below the limit, and exact as a JS number", () => {
    for (let i = 0; i < 1000; i++) {
      const s = drawSeed();
      assert.ok(Number.isSafeInteger(s) && s >= 0 && s < DRAW_SEED_LIMIT);
    }
  });

  it("maps to a valid index for any pool size, reaching the last entry too", () => {
    assert.equal(drawIndex(0, 5), 0);
    assert.equal(drawIndex(4, 5), 4);
    assert.equal(drawIndex(DRAW_SEED_LIMIT - 1, 3), (DRAW_SEED_LIMIT - 1) % 3);
    assert.equal(drawIndex(123, 0), null);
  });
});

describe("lucky draw spin (source pins)", () => {
  // Deliberately static: the service needs a database, and what matters here is the
  // order of operations inside the transaction.
  const service = readFileSync(
    path.join(process.cwd(), "src", "services", "LuckyDrawService.ts"),
    "utf8",
  );
  const spin = service.slice(service.indexOf("async spin("));

  it("reads the trial spins inside the transaction, after the company lock", () => {
    const lock = spin.indexOf("lockCompany(");
    const trial = spin.indexOf("this.trialSpins(companyId, manager)");
    assert.ok(lock >= 0 && trial > lock, "trialSpins must run after lockCompany, with the manager");
  });

  it("counts and picks in one statement", () => {
    assert.match(spin, /pickRandomEntry\(/);
    assert.doesNotMatch(spin, /countEligible\(/);
  });
});
