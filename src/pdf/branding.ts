import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { jsPDF } from "jspdf";

/**
 * Server-side twin of the frontend's PDF branding.
 *
 * These documents moved here because a PDF attached to an email cannot be produced by
 * a browser that is not running. The layout mirrors the frontend module deliberately,
 * so a merchant's emailed report and their downloaded one are the same document.
 */

export const BRAND = {
  primary: [13, 148, 136] as [number, number, number],
  accent: [249, 115, 22] as [number, number, number],
  text: [15, 23, 42] as [number, number, number],
  textSoft: [100, 116, 139] as [number, number, number],
  textFaint: [148, 163, 184] as [number, number, number],
  border: [226, 232, 240] as [number, number, number],
  rowAlt: [240, 253, 250] as [number, number, number],
};

export const PAGE = { margin: 20 };
export const PLATFORM_TAGLINE = "Customer Purchase Tracking Platform";
export const PLATFORM_DOMAIN = "kimates.com";
export const WORDMARK_RATIO = 450 / 98;
export const RUNNING_HEADER_HEIGHT = 24;

export function pageSize(doc: jsPDF): { width: number; height: number; margin: number } {
  return {
    width: doc.internal.pageSize.getWidth(),
    height: doc.internal.pageSize.getHeight(),
    margin: PAGE.margin,
  };
}

export interface BrandAssets {
  wordmark: string | null;
  icon: string | null;
}

let cached: BrandAssets | null = null;

/**
 * Read the brand images off disk once.
 *
 * Resolved relative to this module rather than the working directory: pm2 gives no
 * guarantee about where the process was started from, and a logo that only goes
 * missing in production is the worst way to find that out.
 */
export function loadBrandAssets(): BrandAssets {
  if (cached) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../assets/brand"),
    path.join(here, "../../src/assets/brand"),
    path.join(process.cwd(), "src/assets/brand"),
  ];

  const read = (file: string): string | null => {
    for (const dir of candidates) {
      try {
        const full = path.join(dir, file);
        if (fs.existsSync(full)) {
          return `data:image/png;base64,${fs.readFileSync(full).toString("base64")}`;
        }
      } catch {
        // Branding must degrade to a text lockup, never throw.
      }
    }
    return null;
  };

  cached = { wordmark: read("kimates-logo.png"), icon: read("kimates-icon.png") };
  return cached;
}

export function drawWordmark(
  doc: jsPDF,
  assets: BrandAssets,
  x: number,
  y: number,
  height: number,
): number {
  if (assets.wordmark) {
    const width = height * WORDMARK_RATIO;
    doc.addImage(assets.wordmark, "PNG", x, y, width, height);
    return width;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(height * 2.6);
  doc.setTextColor(...BRAND.primary);
  doc.text("KIMates", x, y + height * 0.85);
  return doc.getTextWidth("KIMates");
}

function drawSpacedCaps(doc: jsPDF, text: string, x: number, y: number): void {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...BRAND.primary);
  doc.setCharSpace(1.15);
  doc.text(text.toUpperCase(), x, y);
  // Char spacing is document state — leaking it wide-sets every later string.
  doc.setCharSpace(0);
}

export function drawHeader(
  doc: jsPDF,
  assets: BrandAssets,
  opts: { title: string; subtitle?: string; companyName?: string },
): number {
  const { margin, width } = pageSize(doc);

  doc.setFillColor(...BRAND.primary);
  doc.rect(0, 0, width, 4, "F");
  doc.setFillColor(...BRAND.accent);
  doc.rect(0, 0, 52, 4, "F");

  const logoTop = 13;
  const logoHeight = 14;
  drawWordmark(doc, assets, margin, logoTop, logoHeight);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.textFaint);
  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  doc.text(`Generated ${dateStr}`, width - margin, logoTop + logoHeight * 0.65, { align: "right" });

  let y = logoTop + logoHeight + 6;
  drawSpacedCaps(doc, PLATFORM_TAGLINE, margin, y);

  y += 4;
  doc.setDrawColor(...BRAND.border);
  doc.setLineWidth(0.3);
  doc.line(margin, y, width - margin, y);

  y += 11;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(...BRAND.text);
  doc.text(opts.title, margin, y);

  if (opts.subtitle) {
    y += 6.5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...BRAND.textSoft);
    doc.text(opts.subtitle, margin, y);
  }

  if (opts.companyName) {
    y += 5.5;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...BRAND.primary);
    doc.text(opts.companyName, margin, y);
  }

  y += 5;
  doc.setDrawColor(...BRAND.primary);
  doc.setLineWidth(0.8);
  doc.line(margin, y, width - margin, y);

  return y + 7;
}

export function drawRunningHeader(doc: jsPDF, assets: BrandAssets, title: string): void {
  const { margin, width } = pageSize(doc);
  doc.setFillColor(...BRAND.primary);
  doc.rect(0, 0, width, 2.5, "F");
  doc.setFillColor(...BRAND.accent);
  doc.rect(0, 0, 52, 2.5, "F");
  drawWordmark(doc, assets, margin, 9, 7);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.textFaint);
  doc.text(title, width - margin, 14.5, { align: "right" });
  doc.setDrawColor(...BRAND.border);
  doc.setLineWidth(0.3);
  doc.line(margin, 19, width - margin, 19);
}

export function drawFooterOnAllPages(doc: jsPDF, assets: BrandAssets): void {
  const { margin, width, height } = pageSize(doc);
  const pageCount = doc.getNumberOfPages();

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const y = height - margin + 5;

    doc.setDrawColor(...BRAND.border);
    doc.setLineWidth(0.3);
    doc.line(margin, y - 5, width - margin, y - 5);

    let x = margin;
    const iconSize = 4.6;
    if (assets.icon) {
      doc.addImage(assets.icon, "PNG", x, y - iconSize + 1, iconSize, iconSize);
      x += iconSize + 2;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...BRAND.primary);
    doc.text("KIMates", x, y);
    x += doc.getTextWidth("KIMates") + 2.5;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...BRAND.textFaint);
    doc.text(PLATFORM_TAGLINE, x, y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const pageLabel = `Page ${i} of ${pageCount}`;
    const sep = "  ·  ";
    let tx = width - margin - doc.getTextWidth(`${PLATFORM_DOMAIN}${sep}${pageLabel}`);
    doc.setTextColor(...BRAND.textFaint);
    doc.text(`${PLATFORM_DOMAIN}${sep}`, tx, y);
    tx += doc.getTextWidth(`${PLATFORM_DOMAIN}${sep}`);
    doc.setTextColor(...BRAND.textSoft);
    doc.text(pageLabel, tx, y);
  }
}

/** The finished document as bytes, for an HTTP response or an email attachment. */
export function toBuffer(doc: jsPDF): Buffer {
  return Buffer.from(doc.output("arraybuffer") as ArrayBuffer);
}
