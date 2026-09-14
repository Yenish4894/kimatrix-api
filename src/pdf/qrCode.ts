import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import {
  BRAND,
  drawFooterOnAllPages,
  drawHeader,
  loadBrandAssets,
  pageSize,
  toBuffer,
} from "@/pdf/branding";
import { pdfText } from "@/pdf/invoice";

/**
 * The printable QR poster emailed to a company when it first gets access.
 *
 * Drawn exactly like the frontend's codes (frontend/src/lib/qr.ts) — brand teal, error
 * correction "H", KIMates icon in the centre — so every QR a customer can meet looks
 * the same. "H" (30% recoverable) is what makes the centre logo safe: the modules under
 * it are reconstructed rather than read. Never lower it while the logo is drawn.
 * The PNG is rendered at 1024px so the printed code stays crisp at 110 mm.
 */
export const QR_FG = "#0891B2";
/**
 * Centre logo size as a fraction of the whole PNG. The PNG includes a 2-module quiet
 * zone, so 0.18 of the image is ~0.2 of the code itself — the ratio the frontend uses
 * and scan-tested (QR_LOGO_RATIO).
 */
export const QR_LOGO_FRACTION = 0.18;

export async function qrPngDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 1024,
    color: { dark: QR_FG, light: "#ffffff" },
  });
}

export interface QrCodePdfInput {
  companyName: string;
  qrUrl: string;
  /** A `data:image/png;base64,...` URL, from qrPngDataUrl. */
  qrDataUrl: string;
}

export function renderQrCodePdf(input: QrCodePdfInput): Buffer {
  const assets = loadBrandAssets();
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const { width, margin } = pageSize(doc);

  let y = drawHeader(doc, assets, {
    title: "Your QR code",
    companyName: pdfText(input.companyName, 80),
  });

  const size = 110;
  const qrX = (width - size) / 2;
  const qrY = y + 4;
  doc.addImage(input.qrDataUrl, "PNG", qrX, qrY, size, size);

  // KIMates icon in the centre, on a white patch that clears the modules beneath it
  // (the same "excavate" the frontend does). Skipped if the asset is missing — a plain
  // code still scans, a broken image would not.
  if (assets.icon) {
    const plate = size * QR_LOGO_FRACTION;
    const plateX = qrX + (size - plate) / 2;
    const plateY = qrY + (size - plate) / 2;
    doc.setFillColor(255, 255, 255);
    doc.rect(plateX, plateY, plate, plate, "F");
    const icon = plate * 0.86;
    doc.addImage(
      assets.icon,
      "PNG",
      plateX + (plate - icon) / 2,
      plateY + (plate - icon) / 2,
      icon,
      icon,
    );
  }
  y += size + 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...BRAND.text);
  doc.text("Scan to submit your purchase", width / 2, y, { align: "center" });

  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...BRAND.textSoft);
  doc.text(pdfText(input.qrUrl, 110), width / 2, y, { align: "center" });

  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.setTextColor(...BRAND.primary);
  doc.text(
    doc.splitTextToSize(
      "Print this page and display it where your customers pay, such as at the counter or the pumps.",
      width - margin * 2,
    ) as string[],
    width / 2,
    y,
    { align: "center" },
  );

  drawFooterOnAllPages(doc, assets);
  return toBuffer(doc);
}

export async function buildQrCodePdf(
  companyName: string,
  qrUrl: string,
): Promise<{ filename: string; body: Buffer }> {
  const qrDataUrl = await qrPngDataUrl(qrUrl);
  return {
    filename: "kimates-qr-code.pdf",
    body: renderQrCodePdf({ companyName, qrUrl, qrDataUrl }),
  };
}
