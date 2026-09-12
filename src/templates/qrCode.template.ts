import { brandName, renderBrandedEmail, type RenderedEmail } from "@/templates/layout";

export interface QrCodeEmailData {
  companyName: string;
  qrUrl: string;
  /** The dashboard page where the code can be downloaded again. */
  qrPageUrl?: string;
}

/** Sent once, when the owner first proves their mailbox (verify link or invite). */
export function renderQrCodeEmail(data: QrCodeEmailData): RenderedEmail {
  const brand = brandName();
  return renderBrandedEmail({
    subject: `Your ${brand} QR code`,
    heading: "Your QR code is ready",
    paragraphs: [
      `The customer QR code for ${data.companyName} is attached to this email as a PDF.`,
      `Print it and display it where your customers pay, such as at the counter or the pumps. Customers scan it with their phone camera and submit their purchase in seconds, with no app and no login.`,
      `The code opens ${data.qrUrl}`,
    ],
    ...(data.qrPageUrl ? { cta: { label: "View your QR code", url: data.qrPageUrl } } : {}),
    companyName: data.companyName,
  });
}
