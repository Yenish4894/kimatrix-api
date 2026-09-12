import { config } from "@/config/index";

/**
 * The public URL a company's QR code encodes.
 *
 * Must stay identical to CompanyService.buildQrUrl, which is what the dashboard shows and
 * what the frontend renders into its own QR: a printed code that pointed anywhere else
 * would be a second, different code for the same shop.
 */
export function buildPublicQrUrl(qrToken: string): string {
  const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
  return `${base}/qr/${qrToken}`;
}
