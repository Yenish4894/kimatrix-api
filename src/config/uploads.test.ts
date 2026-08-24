import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ATTACHMENT_MAX_BYTES, formatBytes, isAllowedAttachment } from "@/config/uploads";

describe("attachment rules", () => {
  it("caps at exactly 10 MB", () => {
    assert.equal(ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
    assert.equal(formatBytes(ATTACHMENT_MAX_BYTES), "10.0 MB");
  });

  it("allows the document and image types an admin would actually send", () => {
    for (const name of ["notice.pdf", "poster.PNG", "list.csv", "terms.docx"]) {
      assert.ok(isAllowedAttachment(name), `${name} should be allowed`);
    }
  });

  it("refuses anything executable or scriptable", () => {
    // This file goes to every company on the platform. Getting it wrong means mailing
    // an executable to every customer, and providers would blacklist the domain for it.
    for (const name of ["setup.exe", "run.sh", "macro.docm", "app.js", "payload.html"]) {
      assert.ok(!isAllowedAttachment(name), `${name} must be refused`);
    }
  });

  it("refuses a double extension trying to sneak past", () => {
    // Only the final extension counts, which is what the mail client will act on.
    assert.ok(!isAllowedAttachment("invoice.pdf.exe"));
    assert.ok(isAllowedAttachment("invoice.exe.pdf"));
  });

  it("refuses a file with no extension at all", () => {
    assert.ok(!isAllowedAttachment("README"));
    assert.ok(!isAllowedAttachment(""));
  });

  it("formats sizes the way the error message needs to read", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(15 * 1024 * 1024), "15.0 MB");
  });
});
