import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import {
  BRAND,
  PAGE,
  RUNNING_HEADER_HEIGHT,
  drawFooterOnAllPages,
  drawHeader,
  drawRunningHeader,
  loadBrandAssets,
  pageSize,
  toBuffer,
  type BrandAssets,
} from "@/pdf/branding";
import { formatPdfCurrency } from "@/pdf/currency";

export type ReportKind = "top10" | "customers" | "purchases";

export interface CustomerRow {
  full_name: string | null;
  mobile: string | null;
  vehicle_number: string | null;
  total_invoice_amount: string | number | null;
  submission_count: number | string | null;
  first_submission_at: Date | string | null;
  last_submission_at: Date | string | null;
}

export interface PurchaseRow {
  invoice_number: string | null;
  invoice_amount: string | number | null;
  mobile: string | null;
  full_name_snapshot: string | null;
  vehicle_number_snapshot: string | null;
  submitted_at: Date | string | null;
}

export interface ReportContext {
  companyName: string;
  country: string;
}

const TITLES: Record<ReportKind, string> = {
  top10: "Top 10 Customers",
  customers: "All Customers",
  purchases: "All Transactions",
};

function amountOf(value: string | number | null | undefined): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * Highest spend first, ranked with ties sharing a place.
 *
 * RANK(), not ROW_NUMBER(). Printing 1, 2, 3 down a column of identical totals tells
 * whoever is running a draw that there is a winner where there is really a tie to
 * settle. Ties break on mobile so two downloads of the same data never disagree about
 * the order.
 */
export function rankCustomers(rows: CustomerRow[]): { row: CustomerRow; rank: number }[] {
  const sorted = [...rows].sort((a, b) => {
    const diff = amountOf(b.total_invoice_amount) - amountOf(a.total_invoice_amount);
    if (diff !== 0) return diff;
    return String(a.mobile ?? "").localeCompare(String(b.mobile ?? ""));
  });

  const out: { row: CustomerRow; rank: number }[] = [];
  let rank = 0;
  let previous: number | null = null;
  sorted.forEach((row, i) => {
    const value = amountOf(row.total_invoice_amount);
    if (previous === null || value !== previous) rank = i + 1;
    previous = value;
    out.push({ row, rank });
  });
  return out;
}

/**
 * The top ten, keeping everyone tied at the cutoff.
 *
 * A strict slice of ten would drop a customer whose spend exactly equals the tenth
 * place — indefensible when the list is being used to hand out a prize.
 */
export function topTen(rows: CustomerRow[]): { row: CustomerRow; rank: number }[] {
  const ranked = rankCustomers(rows);
  const tenth = ranked[9];
  if (!tenth) return ranked;
  const cutoff = amountOf(tenth.row.total_invoice_amount);
  return ranked.filter((entry) => amountOf(entry.row.total_invoice_amount) >= cutoff);
}

function buildDoc(kind: ReportKind, ctx: ReportContext, subtitle: string) {
  const assets = loadBrandAssets();
  // The top ten is five columns and is meant to be printed and read aloud, so it stays
  // upright. The full listings are too wide for portrait without shrinking the type.
  const orientation = kind === "top10" ? "portrait" : "landscape";
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation });
  const startY = drawHeader(doc, assets, {
    title: TITLES[kind],
    subtitle,
    companyName: ctx.companyName,
  });
  return { doc, assets, startY };
}

function finish(doc: jsPDF, assets: BrandAssets): Buffer {
  drawFooterOnAllPages(doc, assets);
  return toBuffer(doc);
}

function emptyState(doc: jsPDF, startY: number): void {
  const { width } = pageSize(doc);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(11);
  doc.setTextColor(...BRAND.textFaint);
  doc.text("There is no data to report yet.", width / 2, startY + 25, { align: "center" });
}

const TABLE_STYLES = {
  font: "helvetica" as const,
  cellPadding: { top: 2.6, right: 2.5, bottom: 2.6, left: 2.5 },
  textColor: BRAND.text,
  lineColor: BRAND.border,
  lineWidth: 0.1,
  overflow: "linebreak" as const,
};

const HEAD_STYLES = {
  fillColor: BRAND.primary,
  textColor: [255, 255, 255] as [number, number, number],
  fontStyle: "bold" as const,
};

/**
 * Top ten by spend, with the first three places set in bold.
 *
 * The bold is the point of this document: it is read out at a prize draw, so the three
 * places that matter have to be findable at a glance rather than counted down to.
 */
export function renderTop10Pdf(rows: CustomerRow[], ctx: ReportContext): Buffer {
  const ranked = topTen(rows);
  const extra = ranked.length > 10 ? ` (${ranked.length} shown — ties at the cutoff)` : "";
  const { doc, assets, startY } = buildDoc(
    "top10",
    ctx,
    ranked.length === 0 ? "No customers yet" : `Ranked by total spend${extra}`,
  );

  if (ranked.length === 0) {
    emptyState(doc, startY);
    return finish(doc, assets);
  }

  const { margin } = pageSize(doc);
  autoTable(doc, {
    startY,
    head: [["#", "Customer", "Mobile", "Purchases", "Total spend"]],
    body: ranked.map(({ row, rank }) => [
      String(rank),
      row.full_name ?? "",
      row.mobile ?? "",
      String(row.submission_count ?? 0),
      formatPdfCurrency(row.total_invoice_amount, ctx.country),
    ]),
    theme: "plain",
    margin: { left: margin, right: margin, top: RUNNING_HEADER_HEIGHT, bottom: PAGE.margin + 5 },
    styles: { ...TABLE_STYLES, fontSize: 10 },
    headStyles: { ...HEAD_STYLES, fontSize: 9.5 },
    columnStyles: {
      0: { halign: "center", cellWidth: 14 },
      2: { font: "courier", cellWidth: 38 },
      3: { halign: "right", cellWidth: 24 },
      4: { halign: "right", cellWidth: 38 },
    },
    rowPageBreak: "avoid",
    didParseCell: (data) => {
      if (data.section !== "body") return;
      // Keyed on rank, not row index: a three-way tie for first bolds three rows, and
      // the fourth-placed customer is not bolded merely for sitting in row three.
      const entry = ranked[data.row.index];
      if (entry && entry.rank <= 3) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.fillColor = BRAND.rowAlt;
      }
    },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawRunningHeader(doc, assets, `${TITLES.top10} — ${ctx.companyName}`);
      }
    },
  });

  return finish(doc, assets);
}

export function renderCustomersPdf(rows: CustomerRow[], ctx: ReportContext): Buffer {
  const ranked = rankCustomers(rows);
  const { doc, assets, startY } = buildDoc(
    "customers",
    ctx,
    `${rows.length} customer${rows.length === 1 ? "" : "s"} — highest total spend first`,
  );

  if (ranked.length === 0) {
    emptyState(doc, startY);
    return finish(doc, assets);
  }

  const { margin } = pageSize(doc);
  autoTable(doc, {
    startY,
    head: [["#", "Full name", "Mobile", "Vehicle", "Total spend", "Purchases", "First", "Last"]],
    body: ranked.map(({ row, rank }) => [
      String(rank),
      row.full_name ?? "",
      row.mobile ?? "",
      row.vehicle_number ?? "",
      formatPdfCurrency(row.total_invoice_amount, ctx.country),
      String(row.submission_count ?? 0),
      formatDateTime(row.first_submission_at),
      formatDateTime(row.last_submission_at),
    ]),
    theme: "plain",
    margin: { left: margin, right: margin, top: RUNNING_HEADER_HEIGHT, bottom: PAGE.margin + 5 },
    styles: { ...TABLE_STYLES, fontSize: 8.5 },
    headStyles: { ...HEAD_STYLES, fontSize: 8.5 },
    columnStyles: {
      0: { halign: "center", cellWidth: 12 },
      2: { font: "courier", cellWidth: 34 },
      4: { halign: "right", cellWidth: 34 },
      5: { halign: "right", cellWidth: 22 },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    rowPageBreak: "avoid",
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawRunningHeader(doc, assets, `${TITLES.customers} — ${ctx.companyName}`);
      }
    },
  });

  return finish(doc, assets);
}

export function renderPurchasesPdf(rows: PurchaseRow[], ctx: ReportContext): Buffer {
  const { doc, assets, startY } = buildDoc(
    "purchases",
    ctx,
    `${rows.length} transaction${rows.length === 1 ? "" : "s"} — newest first`,
  );

  if (rows.length === 0) {
    emptyState(doc, startY);
    return finish(doc, assets);
  }

  const { margin } = pageSize(doc);
  autoTable(doc, {
    startY,
    head: [["#", "Invoice", "Amount", "Customer", "Mobile", "Vehicle", "Submitted"]],
    body: rows.map((row, i) => [
      String(i + 1),
      row.invoice_number ?? "",
      formatPdfCurrency(row.invoice_amount, ctx.country),
      row.full_name_snapshot ?? "",
      row.mobile ?? "",
      row.vehicle_number_snapshot ?? "",
      formatDateTime(row.submitted_at),
    ]),
    theme: "plain",
    margin: { left: margin, right: margin, top: RUNNING_HEADER_HEIGHT, bottom: PAGE.margin + 5 },
    styles: { ...TABLE_STYLES, fontSize: 8.5 },
    headStyles: { ...HEAD_STYLES, fontSize: 8.5 },
    columnStyles: {
      0: { halign: "center", cellWidth: 12 },
      2: { halign: "right", cellWidth: 34 },
      4: { font: "courier", cellWidth: 34 },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    rowPageBreak: "avoid",
    didDrawPage: (data) => {
      if (data.pageNumber > 1) {
        drawRunningHeader(doc, assets, `${TITLES.purchases} — ${ctx.companyName}`);
      }
    },
  });

  return finish(doc, assets);
}

export const REPORT_TITLES = TITLES;
