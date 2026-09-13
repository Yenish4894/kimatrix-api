import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACHMENT_MAX_BYTES,
  contentMatchesExtension,
  formatBytes,
  isAllowedAttachment,
} from "@/config/uploads";

describe("attachment rules", () => {
  it("caps at exactly 10 MB", () => {
    assert.equal(ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
    assert.equal(formatBytes(ATTACHMENT_MAX_BYTES), "10.0 MB");
  });

  it("allows the document and image types an admin would actually send", () => {
    for (const name of ["notice.pdf", "poster.PNG", "list.csv", "terms.docx", "sheet.xlsx"]) {
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

  it("refuses the legacy macro-capable Office formats", () => {
    for (const name of ["letter.doc", "prices.xls", "LETTER.DOC"]) {
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

describe("attachment content check", () => {
  const bytes = (...parts: (string | number[])[]) =>
    Buffer.concat(
      parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))),
    );
  const ZIP = [0x50, 0x4b, 0x03, 0x04];
  const docx = bytes(ZIP, "....[Content_Types].xml....word/document.xml....");
  const xlsx = bytes(ZIP, "....[Content_Types].xml....xl/workbook.xml....");

  it("accepts files whose bytes match their extension", () => {
    assert.ok(contentMatchesExtension("a.pdf", bytes("%PDF-1.7\n...")));
    assert.ok(
      contentMatchesExtension("a.png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    );
    assert.ok(contentMatchesExtension("a.JPG", bytes([0xff, 0xd8, 0xff, 0xe0])));
    assert.ok(contentMatchesExtension("a.gif", bytes("GIF89a....")));
    assert.ok(contentMatchesExtension("a.webp", bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 ")));
    assert.ok(contentMatchesExtension("a.docx", docx));
    assert.ok(contentMatchesExtension("a.xlsx", xlsx));
    assert.ok(contentMatchesExtension("a.csv", bytes("name,amount\nAsha,120.50\n")));
    assert.ok(contentMatchesExtension("a.txt", bytes("Héllo — plain text\r\n")));
  });

  it("refuses an executable renamed to an allowed extension", () => {
    const exe = bytes("MZ", [0x90, 0, 3, 0]);
    for (const name of ["notice.pdf", "poster.png", "terms.docx", "list.csv", "readme.txt"]) {
      assert.ok(!contentMatchesExtension(name, exe), `${name} holding an .exe must be refused`);
    }
  });

  it("refuses a legacy OLE .doc renamed to .docx", () => {
    const ole = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "....");
    assert.ok(!contentMatchesExtension("letter.docx", ole));
  });

  it("refuses a .docx or .xlsx that carries a macro project (a renamed .docm/.xlsm)", () => {
    assert.ok(
      !contentMatchesExtension("a.docx", Buffer.concat([docx, bytes("word/vbaProject.bin")])),
    );
    assert.ok(
      !contentMatchesExtension("a.xlsx", Buffer.concat([xlsx, bytes("xl/vbaProject.bin")])),
    );
  });

  it("refuses a spreadsheet posing as a document and vice versa", () => {
    assert.ok(!contentMatchesExtension("a.docx", xlsx));
    assert.ok(!contentMatchesExtension("a.xlsx", docx));
  });

  it("refuses binary content under a text extension", () => {
    assert.ok(!contentMatchesExtension("a.csv", bytes("a,b\n", [0], "c")));
    assert.ok(!contentMatchesExtension("a.txt", docx));
    assert.ok(!contentMatchesExtension("a.txt", bytes("%PDF-1.4")));
  });

  it("refuses an empty file and an unknown extension", () => {
    assert.ok(!contentMatchesExtension("a.pdf", Buffer.alloc(0)));
    assert.ok(!contentMatchesExtension("a.exe", bytes("MZ")));
  });
});
