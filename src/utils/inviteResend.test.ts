import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inviteResendBlock } from "@/utils/inviteResend";

describe("inviteResendBlock", () => {
  it("refuses a self-registered company with 400, whatever its verification state", () => {
    for (const ownerEmailVerified of [true, false]) {
      const block = inviteResendBlock({ createdByAdmin: false, ownerEmailVerified });
      assert.equal(block?.status, 400);
      assert.match(block?.message ?? "", /signed up by itself/);
    }
  });

  it("refuses an admin-created company whose owner already set up the account with 409", () => {
    assert.equal(
      inviteResendBlock({ createdByAdmin: true, ownerEmailVerified: true })?.status,
      409,
    );
  });

  it("allows an admin-created company whose owner never set a password", () => {
    assert.equal(inviteResendBlock({ createdByAdmin: true, ownerEmailVerified: false }), null);
  });
});
