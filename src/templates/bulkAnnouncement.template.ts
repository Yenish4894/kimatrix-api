import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

interface BulkAnnouncementTemplateData {
  /** Subject the admin typed — also used as the heading inside the message. */
  subject: string;
  /** Free text the admin typed. Blank lines separate paragraphs. */
  body: string;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The branded shell for an admin broadcast.
 *
 * Bulk email used to be the one message type sent without a template: the body was
 * wrapped in bare <p> tags and handed straight to the mailer. No doctype, no
 * background, no card, no sign-off — so a platform-wide announcement from KIMates
 * arrived looking like a raw HTML fragment, while a password reset from the same
 * system looked polished. This puts it in the same shell as every other email.
 */
export function renderBulkAnnouncementEmail(data: BulkAnnouncementTemplateData): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = data.subject.trim();

  // Blank lines separate paragraphs; single newlines stay inside one. Written by
  // someone typing into a textarea, so it must behave the way a textarea looks.
  const paragraphs = data.body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) => `<p style="margin:0 0 16px;">${escapeHtml(block).replaceAll("\n", "<br />")}</p>`,
    )
    .join("");

  const text = [data.body.trim(), "", `— ${brand}`].join("\n");

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
              <td style="padding:20px 40px;background:#0d9488;">
                <span style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.3px;">${escapeHtml(brand)}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 40px 8px;">
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">${escapeHtml(subject)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 24px;font-size:15px;line-height:1.6;color:#374151;">
                ${paragraphs}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0;">You're receiving this because your business has an account with ${escapeHtml(brand)}.</p>
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
