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

  it("gives tied customers the same rank, then skips", () => {
    // RANK(), not ROW_NUMBER(). 1, 2, 3 down a column of identical totals claims a
    // winner where there is really a tie to settle — and this list decides a prize.
    const ranked = rankCustomers([customer("b", "100"), customer("a", "100"), customer("c", "50")]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 1, 3],
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

  it("keeps everyone tied at the cutoff rather than cutting mid-tie", () => {
    // Dropping a customer whose spend exactly equals tenth place is indefensible when
    // the list is being used to hand out a prize.
    const rows = [...many(9), customer("tie-a", "100"), customer("tie-b", "100")];
    const top = topTen(rows);
    assert.equal(top.length, 11, "both customers on the cutoff amount must appear");
    assert.deepEqual(
      top.slice(-2).map((r) => r.rank),
      [10, 10],
    );
  });

  it("bolding is keyed on rank, so a tie for first bolds three rows", () => {
    // Bolding by row index would bold the fourth-placed customer merely for sitting in
    // the third row, and would miss a third customer genuinely tied for first.
    const rows = [
      customer("a", "500"),
      customer("b", "500"),
      customer("c", "500"),
      customer("d", "100"),
    ];
    const top = topTen(rows);
    assert.deepEqual(
      top.map((r) => r.rank),
      [1, 1, 1, 4],
    );
    assert.equal(top.filter((r) => r.rank <= 3).length, 3);
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
