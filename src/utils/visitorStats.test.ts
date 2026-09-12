import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toVisitorStats } from "@/utils/visitorStats";

describe("toVisitorStats", () => {
  it("turns Postgres bigint strings into numbers", () => {
    assert.deepEqual(
      toVisitorStats({ today: "3", last7Days: "40", last30Days: "120", total: "9001" }),
      { today: 3, last7Days: 40, last30Days: 120, total: 9001 },
    );
  });

  it("reports zeros for an empty table (null sums) or a missing row", () => {
    const zero = { today: 0, last7Days: 0, last30Days: 0, total: 0 };
    assert.deepEqual(
      toVisitorStats({ today: null, last7Days: null, last30Days: null, total: null }),
      zero,
    );
    assert.deepEqual(toVisitorStats(undefined), zero);
  });

  it("never returns NaN or a negative", () => {
    assert.deepEqual(toVisitorStats({ today: "abc", last7Days: -4, last30Days: 2.7, total: 5 }), {
      today: 0,
      last7Days: 0,
      last30Days: 2,
      total: 5,
    });
  });
});
