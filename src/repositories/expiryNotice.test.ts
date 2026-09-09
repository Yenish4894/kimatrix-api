import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXPIRY_NOTICE_SQL } from "@/repositories/CompanyRepository";

/**
 * Which expiry notices may be sent to an address nobody has confirmed.
 *
 * This is a policy decision with a production incident behind it, not a style choice,
 * so it is pinned here rather than left to whoever next edits the query. On 2026-09-08
 * the trial_ended notice went to test@gmail.com and tvb@gmail.com, both of which
 * bounced, and Hostinger suspended outbound sending for the whole mailbox — taking
 * password resets, verification and every real customer's mail down with it.
 *
 * The split is deliberate in both directions. Guarding the trial notices is what stops
 * that recurring. NOT guarding the paid ones is equally deliberate: a company can
 * register, skip verification and pay, and silently letting a paying customer's plan
 * lapse unwarned is worse than a rare bounce.
 */
describe("expiry notice verification policy", () => {
  it("never mails an unconfirmed address about a trial", () => {
    assert.equal(EXPIRY_NOTICE_SQL.trial_ending.requiresVerifiedEmail, true);
    assert.equal(EXPIRY_NOTICE_SQL.trial_ended.requiresVerifiedEmail, true);
  });

  it("still warns paying customers even if they never confirmed their email", () => {
    assert.equal(EXPIRY_NOTICE_SQL.subscription_ending.requiresVerifiedEmail, false);
    assert.equal(EXPIRY_NOTICE_SQL.subscription_ended.requiresVerifiedEmail, false);
  });

  it("covers every notice kind, so a new one cannot silently default", () => {
    for (const [kind, spec] of Object.entries(EXPIRY_NOTICE_SQL)) {
      assert.equal(
        typeof spec.requiresVerifiedEmail,
        "boolean",
        `${kind} must state its verification policy explicitly`,
      );
    }
  });
});
