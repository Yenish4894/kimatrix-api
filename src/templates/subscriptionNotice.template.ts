import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";
import type { ExpiryNoticeKind } from "@/repositories/CompanyRepository";

export interface SubscriptionNoticeTemplateData {
  kind: ExpiryNoticeKind;
  companyName: string;
  /** When access lapses (or lapsed). */
  deadline: Date;
  billingUrl: string;
  exportUrl: string;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * One shell, three messages. Written as a lookup rather than three template files
 * because the layout is identical and only the words change — three copies would
 * drift, and the drift would be invisible until a customer received the wrong one.
 */
function copyFor(
  kind: ExpiryNoticeKind,
  brand: string,
  companyName: string,
  when: string,
): { subject: string; heading: string; body: string[]; cta: string } {
  switch (kind) {
    case "trial_ending":
      return {
        subject: `Your ${brand} free trial ends ${when}`,
        heading: "Your free trial is nearly up",
        body: [
          `Your free trial for ${companyName} ends ${when}.`,
          `To keep collecting customer purchases after that, choose a plan. Your QR code stays the same, so there is nothing to reprint and nothing for your customers to relearn.`,
          `If you'd rather stop here, you can download everything you've collected at any time — it's yours.`,
        ],
        cta: "Choose a plan",
      };
    case "trial_ended":
      return {
        subject: `Your ${brand} free trial has ended`,
        heading: "Your free trial has ended",
        body: [
          `The free trial for ${companyName} ended ${when}, so your QR code has stopped accepting new submissions and your dashboard is paused.`,
          `Nothing has been deleted. Choose a plan and everything picks up exactly where it left off — same QR code, same customer list.`,
          `If you'd rather not continue, you can still download all of your data.`,
        ],
        cta: "Choose a plan",
      };
    case "subscription_ended":
      return {
        subject: `Your ${brand} subscription has expired`,
        heading: "Your subscription has expired",
        body: [
          `The subscription for ${companyName} expired ${when}, so your QR code has stopped accepting new submissions and your dashboard is paused.`,
          `Your data is safe and untouched. Renew and everything resumes immediately — same QR code, same customer list.`,
          `You can also download all of your data at any time.`,
        ],
        cta: "Renew your plan",
      };
  }
}

export function renderSubscriptionNoticeEmail(data: SubscriptionNoticeTemplateData): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const when = formatDeadline(data.deadline, data.kind);
  const { subject, heading, body, cta } = copyFor(data.kind, brand, data.companyName, when);

  const text = [
    heading,
    "",
    ...body.flatMap((p) => [p, ""]),
    `${cta}: ${data.billingUrl}`,
    `Download your data: ${data.exportUrl}`,
    "",
    `— ${brand}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 16px;">
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">${escapeHtml(heading)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                ${body.map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p)}</p>`).join("\n                ")}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 40px 24px;">
                <a href="${data.billingUrl}" style="display:inline-block;background:#0891B2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(cta)}</a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 40px 24px;font-size:14px;">
                <a href="${data.exportUrl}" style="color:#0e7490;text-decoration:underline;">Download my data instead</a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0;">You're receiving this because you own the ${escapeHtml(data.companyName)} account on ${escapeHtml(brand)}.</p>
                <p style="margin:16px 0 0;">— ${escapeHtml(brand)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}

/**
 * "in 2 days" / "today" for a warning, a plain date for something already past.
 *
 * Rendered server-side in UTC on purpose: an email is read whenever it is read, and a
 * relative label computed at send time is the honest one. The dashboard countdown is
 * where live precision belongs.
 */
function formatDeadline(deadline: Date, kind: ExpiryNoticeKind): string {
  const date = deadline.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  if (kind !== "trial_ending") return `on ${date}`;

  const hours = Math.round((deadline.getTime() - Date.now()) / 3_600_000);
  if (hours <= 24) return `today (${date})`;
  if (hours <= 48) return `tomorrow (${date})`;
  return `on ${date}`;
}
