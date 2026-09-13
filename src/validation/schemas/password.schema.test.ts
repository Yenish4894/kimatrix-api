import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commonPatterns,
  PASSWORD_MAX_BYTES,
  PASSWORD_TOO_LONG_MESSAGE,
} from "@/validation/schemas/common.schema";
import { loginSchema } from "@/validation/schemas/auth.schema";
import { PasswordService } from "@/services/PasswordService";

const check = (value: string) => commonPatterns.password.validate(value);

describe("new-password rule", () => {
  it("accepts a strong password well past the old 18-character cap", () => {
    assert.equal(check("Correct-Horse-Battery-Staple-42").error, undefined);
  });

  it("requires at least 8 characters", () => {
    assert.match(check("Ab1!xyz").error?.message ?? "", /at least 8 characters/);
    assert.equal(check("Ab1!xyzw").error, undefined);
  });

  it("allows up to 72 bytes and refuses 73 with a clear message", () => {
    const base = "Aa1!";
    assert.equal(check(base + "x".repeat(PASSWORD_MAX_BYTES - base.length)).error, undefined);
    const tooLong = check(base + "x".repeat(PASSWORD_MAX_BYTES - base.length + 1));
    assert.equal(tooLong.error?.message, PASSWORD_TOO_LONG_MESSAGE);
  });

  it("counts bytes, not characters, so multi-byte text cannot slip past bcrypt", () => {
    // 4 + 25*3 = 79 bytes in 29 characters.
    const accented = "Aa1!" + "€".repeat(25);
    assert.equal(check(accented).error?.message, PASSWORD_TOO_LONG_MESSAGE);
  });

  it("refuses more than 128 characters", () => {
    assert.match(check("Aa1!" + "x".repeat(130)).error?.message ?? "", /128 characters or fewer/);
  });

  it("still names the character-class rule", () => {
    assert.match(check("alllowercase1!").error?.message ?? "", /uppercase letter/);
  });
});

describe("login is not held to the new-password rule", () => {
  it("accepts a short legacy password, so existing accounts can still sign in", () => {
    const { error } = loginSchema.validate({ identifier: "owner@example.com", password: "abc" });
    assert.equal(error, undefined);
  });
});

describe("PasswordService.hash", () => {
  it("refuses more than 72 bytes instead of letting bcrypt truncate", async () => {
    await assert.rejects(new PasswordService().hash("Aa1!" + "x".repeat(PASSWORD_MAX_BYTES)), {
      message: PASSWORD_TOO_LONG_MESSAGE,
    });
  });
});
