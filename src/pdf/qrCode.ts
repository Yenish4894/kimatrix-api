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
 * Error correction "M" (15%) survives a scuffed or partly covered print at a pump while
 * keeping the modules large enough to scan from arm's length. The PNG is rendered at
 * 1024px so the printed code stays crisp at 110 mm.
 */
export async function qrPngDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 1024 });
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
  doc.addImage(input.qrDataUrl, "PNG", (width - size) / 2, y + 4, size, size);
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
