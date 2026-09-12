import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function brandName(): string {
  return config.SMTP_FROM_NAME || "KIMates";
}

export interface BrandedEmailInput {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** Label/value rows in a bordered summary box (amount, invoice number, period...). */
  details?: [label: string, value: string][];
  cta?: { label: string; url: string };
  /** The company the recipient owns, for the "why am I getting this" footer. */
  companyName: string;
}

/**
 * The shared shell for the billing and onboarding emails: same card, colours and footer
 * as subscriptionNotice.template.ts, so every message from the platform looks alike.
 *
 * Everything interpolated is escaped here, once, so a template cannot forget to. Pass
 * raw strings in; a company called "Tom & Jerry's <Fuel>" arrives intact.
 */
export function renderBrandedEmail(input: BrandedEmailInput): RenderedEmail {
  const brand = brandName();
  const details = input.details ?? [];

  const text = [
    input.heading,
    "",
    ...input.paragraphs.flatMap((p) => [p, ""]),
    ...(details.length ? [...details.map(([label, value]) => `${label}: ${value}`), ""] : []),
    ...(input.cta ? [`${input.cta.label}: ${input.cta.url}`, ""] : []),
    `— ${brand}`,
  ].join("\n");

  const detailRows = details
    .map(
      ([label, value], i) =>
        `<tr>
                    <td style="padding:10px 14px;color:#6b7280;${i < details.length - 1 ? "border-bottom:1px solid #e5e7eb;" : ""}">${escapeHtml(label)}</td>
                    <td style="padding:10px 14px;color:#111827;font-weight:600;text-align:right;${i < details.length - 1 ? "border-bottom:1px solid #e5e7eb;" : ""}">${escapeHtml(value)}</td>
                  </tr>`,
    )
    .join("\n                  ");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(input.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 16px;">
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">${escapeHtml(input.heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                ${input.paragraphs.map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p)}</p>`).join("\n                ")}
              </td>
            </tr>
            ${
              details.length
                ? `<tr>
              <td style="padding:0 40px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;font-size:14px;">
                  ${detailRows}
                </table>
              </td>
            </tr>`
                : ""
            }
            ${
              input.cta
                ? `<tr>
              <td align="center" style="padding:8px 40px 24px;">
                <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;background:#0891B2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(input.cta.label)}</a>
              </td>
            </tr>`
                : ""
            }
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0;">You're receiving this because you own the ${escapeHtml(input.companyName)} account on ${escapeHtml(brand)}.</p>
                <p style="margin:16px 0 0;">— ${escapeHtml(brand)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: input.subject, html, text };
}

/** "24 August 2026", in UTC, matching the expiry notices. */
export function formatEmailDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "USD 1,234.50". Company payments to KIMates are USD; the code is printed regardless. */
export function formatMoney(amount: string | number, currency: string): string {
  const n = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  const value = Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "0.00";
  return `${/^[A-Z]{3}$/.test(currency) ? currency : "USD"} ${value}`;
}
