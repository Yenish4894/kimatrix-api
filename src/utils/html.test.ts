import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml } from "@/utils/html";

describe("escapeHtml", () => {
  it("escapes the ampersand first, so escapes are not double-escaped", () => {
    // Replacing "<" before "&" would turn "<" into "&lt;" and then into "&amp;lt;".
    assert.equal(escapeHtml("<b>"), "&lt;b&gt;");
    assert.equal(escapeHtml("Terms & Conditions"), "Terms &amp; Conditions");
    assert.equal(escapeHtml("a & <b>"), "a &amp; &lt;b&gt;");
  });

  it("handles the punctuation that appears in ordinary admin copy", () => {
    // These are not attacks — they are what someone writes in a normal announcement,
    // and unescaped they break the markup of a mail sent to every company.
    assert.equal(escapeHtml("under <500"), "under &lt;500");
    assert.equal(escapeHtml('say "hello"'), "say &quot;hello&quot;");
    assert.equal(escapeHtml("it's here"), "it&#39;s here");
  });

  it("neutralises a script tag", () => {
    assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("leaves ordinary text untouched", () => {
    assert.equal(escapeHtml("Bonjour Niamey — 30 jours"), "Bonjour Niamey — 30 jours");
    assert.equal(escapeHtml(""), "");
  });
});
