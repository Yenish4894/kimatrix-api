import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankCustomers, topTen, type CustomerRow } from "@/pdf/reports";
import { KNOWN_COUNTRIES, formatPdfCurrency, isPdfSafe, pdfCurrencySymbol } from "@/pdf/currency";

const customer = (mobile: string, total: string | number | null): CustomerRow => ({
  full_name: `Customer ${mobile}`,
  mobile,
  vehicle_number: null,
  total_invoice_amount: total,
  submission_count: 1,
  first_submission_at: null,
  last_submission_at: null,
});

describe("rankCustomers", () => {
  it("puts the biggest spender first", () => {
    const ranked = rankCustomers([
      customer("a", "100"),
      customer("b", "900"),
      customer("c", "500"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.row.mobile),
      ["b", "c", "a"],
    );
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3],
    );
  });

  it("numbers ranks consecutively even when totals tie", () => {
    // Product decision 2026-09-13: "5, 5, 7" / "8, 8, 10" was reported as a bug.
    const ranked = rankCustomers([
      customer("b", "100"),
      customer("a", "100"),
      customer("c", "50"),
      customer("d", "50"),
      customer("e", "10"),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3, 4, 5],
    );
  });

  it("breaks equal totals by more purchases, then by mobile", () => {
    const few = { ...customer("a", "100"), submission_count: 1 };
    const many = { ...customer("z", "100"), submission_count: 5 };
    const ranked = rankCustomers([few, many, customer("m", "100")]);
    assert.deepEqual(
      ranked.map((r) => r.row.mobile),
      ["z", "a", "m"],
    );
  });

  it("treats the same amount written differently as a tie", () => {
    // Postgres NUMERIC comes back as "100.00"; a hand-built row might say "100".
    const ranked = rankCustomers([customer("b", "100.00"), customer("a", 100)]);
    assert.deepEqual(
      ranked.map((r) => r.row.mobile),
      ["a", "b"],
    );
  });

  it("orders ties identically every time", () => {
    // Two downloads of the same data must not disagree about who is above whom.
    const rows = [customer("+22790000009", "100"), customer("+22790000002", "100")];
    const first = rankCustomers(rows).map((r) => r.row.mobile);
    const second = rankCustomers([...rows].reverse()).map((r) => r.row.mobile);
    assert.deepEqual(first, second);
  });

  it("sorts numerically, not as text", () => {
    // The database hands these back as strings; "9" would otherwise beat "125000".
    const ranked = rankCustomers([customer("a", "9"), customer("b", "125000")]);
    assert.equal(ranked[0]!.row.mobile, "b");
  });

  it("keeps a customer whose total never computed", () => {
    const ranked = rankCustomers([customer("a", null), customer("b", "10")]);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]!.row.mobile, "b");
  });

  it("does not mutate the caller's array", () => {
    const rows = [customer("a", "1"), customer("b", "2")];
    rankCustomers(rows);
    assert.deepEqual(
      rows.map((r) => r.mobile),
      ["a", "b"],
    );
  });
});

describe("topTen", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => customer(`m${i}`, String(1000 - i * 10)));

  it("returns ten when there are more than ten", () => {
    assert.equal(topTen(many(30)).length, 10);
  });

  it("returns everyone when there are fewer", () => {
    assert.equal(topTen(many(4)).length, 4);
  });

  it("is exactly ten rows ranked 1 to 10, even with a tie at the cutoff", () => {
    const rows = [...many(9), customer("tie-a", "100"), customer("tie-b", "100")];
    const top = topTen(rows);
    assert.equal(top.length, 10);
    assert.deepEqual(
      top.map((r) => r.rank),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    // The tie at the cutoff is settled by the deterministic tie-break (mobile here).
    assert.equal(top[9]!.row.mobile, "tie-a");
  });

  it("never repeats or skips a rank, whatever the ties", () => {
    // The reported bug: 1 2 3 4 5 5 6 7 8 8 10.
    const rows = [
      customer("a", "900"),
      customer("b", "800"),
      customer("c", "700"),
      customer("d", "600"),
      customer("e", "500"),
      customer("f", "500"),
      customer("g", "400"),
      customer("h", "300"),
      customer("i", "200"),
      customer("j", "200"),
      customer("k", "100"),
    ];
    assert.deepEqual(
      topTen(rows).map((r) => r.rank),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
  });

  it("handles an empty list", () => {
    assert.deepEqual(topTen([]), []);
  });
});

describe("PDF currency", () => {
  it("every country the platform knows survives PDF encoding", () => {
    // jsPDF's Helvetica is WinAnsi. One unencodable character silently switches the
    // whole string to UTF-16 and the amount renders as null bytes.
    const unsafe = KNOWN_COUNTRIES.filter((c) => !isPdfSafe(pdfCurrencySymbol(c)));
    assert.deepEqual(unsafe, []);
  });

  it("prints the CFA franc as FCFA", () => {
    for (const country of ["Niger", "Senegal", "Mali", "Cameroon"]) {
      assert.equal(pdfCurrencySymbol(country), "FCFA");
    }
    assert.equal(formatPdfCurrency("875500", "Niger"), "FCFA 875,500.00");
  });

  it("leaves symbols WinAnsi can already encode alone", () => {
    assert.equal(pdfCurrencySymbol("South Africa"), "R");
    assert.equal(pdfCurrencySymbol("Germany"), "€");
  });

  it("survives the nullable amounts the database returns", () => {
    assert.equal(formatPdfCurrency(null, "Niger"), "FCFA 0.00");
    assert.equal(formatPdfCurrency(undefined, "Niger"), "FCFA 0.00");
  });
});
