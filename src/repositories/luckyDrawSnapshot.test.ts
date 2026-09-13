import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskMobile } from "@/repositories/LuckyDrawRepository";

/**
 * The draw snapshot keeps only the last four digits of the winner's mobile, so a prize
 * dispute can be checked after the customer row is erased without keeping the number.
 * The migration's SQL backfill must produce the same shape.
 */
describe("maskMobile", () => {
  it("keeps only the last four digits", () => {
    assert.equal(maskMobile("+27821234567"), "****4567");
    assert.equal(maskMobile("+91 98765 43210"), "****3210");
  });

  it("reveals nothing for a number too short to mask", () => {
    assert.equal(maskMobile("1234"), "****");
    assert.equal(maskMobile(""), "****");
  });
});
