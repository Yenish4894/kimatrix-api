import { randomInt } from "node:crypto";

/**
 * The random input to a lucky draw pick.
 *
 * The pick used to be two statements: count the pool, choose `randomInt(count)`, then
 * fetch the row at that offset. Under READ COMMITTED each statement sees its own
 * snapshot, so a purchase voided between them shifted every later row up one — the
 * last entry became unreachable and the offset could land on nothing. Now the count and
 * the pick are one statement over one snapshot, which means the random number has to be
 * chosen before the count is known.
 *
 * So the draw passes a large uniform seed and the SQL takes `seed % entries`. The
 * modulo bias is at most entries / 2^47 — below one in a hundred million for any pool
 * this platform will see. crypto.randomInt, not Math.random: it is a prize draw and
 * should be defensible.
 */
export const DRAW_SEED_LIMIT = 2 ** 47;

export function drawSeed(): number {
  return randomInt(0, DRAW_SEED_LIMIT);
}

/** The TypeScript mirror of the SQL pick (`seed % entries`), for tests and reasoning. */
export function drawIndex(seed: number, entries: number): number | null {
  if (!Number.isInteger(entries) || entries <= 0) return null;
  return seed % entries;
}
