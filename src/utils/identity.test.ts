import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeEmail, canonicalizePhone, hashIdentifier, maskIdentifier } from "./identity";

describe("canonicalizeEmail", () => {
  it("lowercases and trims", () => {
    assert.equal(canonicalizeEmail("  John.Doe@Example.COM "), "john.doe@example.com");
  });

  it("strips sub-addressing on any domain", () => {
    assert.equal(canonicalizeEmail("owner+trial1@example.com"), "owner@example.com");
    assert.equal(canonicalizeEmail("owner+trial2@example.com"), "owner@example.com");
  });

  it("strips dots for Gmail only", () => {
    assert.equal(canonicalizeEmail("o.w.n.e.r@gmail.com"), "owner@gmail.com");
    assert.equal(canonicalizeEmail("o.w.n.e.r@googlemail.com"), "owner@googlemail.com");
    // A dot is significant everywhere else — these really are two different people.
    assert.notEqual(canonicalizeEmail("a.b@fastmail.com"), canonicalizeEmail("ab@fastmail.com"));
  });

  it("collapses the Gmail farming trick to one key", () => {
    const variants = [
      "owner@gmail.com",
      "ow.ner@gmail.com",
      "owner+1@gmail.com",
      "o.w.n.e.r+whatever@GMAIL.com",
    ].map(canonicalizeEmail);
    assert.equal(new Set(variants).size, 1, "all four reach one inbox, so all four are one key");
  });

  it("leaves a leading dot alone rather than mangling the address", () => {
    // `+` at position 0 is not sub-addressing; slicing there would produce "".
    assert.equal(canonicalizeEmail("+27team@example.com"), "+27team@example.com");
  });

  it("does not crash on a value with no @", () => {
    assert.equal(canonicalizeEmail("not-an-email"), "not-an-email");
  });
});

describe("canonicalizePhone", () => {
  it("strips the punctuation people paste in", () => {
    assert.equal(canonicalizePhone("+27 11 123-4567"), "+27111234567");
    assert.equal(canonicalizePhone(" +27(11)1234567 "), "+27111234567");
  });

  it("keeps the leading plus meaningful", () => {
    assert.notEqual(canonicalizePhone("+27111234567"), canonicalizePhone("27111234567"));
  });
});

describe("hashIdentifier", () => {
  it("is stable across equivalent spellings", () => {
    assert.equal(
      hashIdentifier("email", "Owner+tag@Gmail.com"),
      hashIdentifier("email", "ow.ner@gmail.com"),
    );
  });

  it("separates the email and phone namespaces", () => {
    // Same canonical string, different type — must not collide, because the unique
    // index sits on the hash alone.
    assert.notEqual(hashIdentifier("email", "12345"), hashIdentifier("phone", "12345"));
  });

  it("produces a 64-char hex digest that fits the column", () => {
    const hash = hashIdentifier("phone", "+27111234567");
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("never returns the identifier itself", () => {
    assert.ok(!hashIdentifier("email", "owner@example.com").includes("owner"));
  });
});

describe("maskIdentifier", () => {
  it("keeps an email recognisable to its owner and useless to anyone else", () => {
    const masked = maskIdentifier("email", "johnsmith@gmail.com");
    assert.ok(masked.startsWith("j"), "first character is kept");
    assert.ok(masked.endsWith("h@gmail.com"), "last character and domain are kept");
    assert.ok(!masked.includes("ohnsmit"), "the middle is hidden");
  });

  it("keeps the country prefix and last four of a phone", () => {
    const masked = maskIdentifier("phone", "+27111234567");
    assert.ok(masked.startsWith("+27"));
    assert.ok(masked.endsWith("4567"));
    assert.ok(!masked.includes("1112345"));
  });

  it("fits the varchar(64) column even for a long address", () => {
    const masked = maskIdentifier("email", `${"a".repeat(200)}@example.com`);
    assert.ok(masked.length <= 64);
  });

  it("does not leak a short local part wholesale", () => {
    assert.ok(!maskIdentifier("email", "ab@example.com").startsWith("ab"));
  });
});
