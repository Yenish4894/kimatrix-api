import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

interface BulkAnnouncementTemplateData {
  /** Subject the admin typed — also the heading inside the message. */
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
 * Modelled on how established products lay out an announcement: the logo alone at the
 * top, a heading, the message, then a footer carrying who sent it and how to stop
 * receiving them. Bulk email was previously the one message type sent with no template
 * at all — bare <p> tags handed straight to the mailer — so a platform-wide
 * announcement arrived looking like a raw fragment while a password reset looked
 * finished.
 *
 * Everything is inline-styled tables. Email clients are not browsers: Gmail strips
 * <style> blocks, Outlook renders through Word, and flexbox does not exist in either.
 */
export function renderBulkAnnouncementEmail(data: BulkAnnouncementTemplateData): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = data.subject.trim();
  const site = config.FRONTEND_BASE_URL.replace(/\/+$/, "");
  const logoUrl = `${site}/brand/kimates-logo.png`;

  // Blank lines separate paragraphs; a single newline stays inside one. Written by
  // someone typing into a textarea, so it has to behave the way a textarea looks.
  const paragraphs = data.body
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#374151;">${escapeHtml(
          block,
        ).replaceAll("\n", "<br />")}</p>`,
    )
    .join("");

  const text = [data.body.trim(), "", `— ${brand}`, site].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <!-- Preheader: the grey line a client shows next to the subject in the inbox
         list. Left unset it fills with whatever markup comes first, which reads as
         gibberish. Hidden in the body itself. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(subject)}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">

            <!-- Logo, centred and alone. The alt text carries the brand for the many clients
                 that block images by default. -->
            <tr>
              <td align="center" style="padding:36px 40px 8px;">
                <img src="${logoUrl}" alt="${escapeHtml(brand)}" width="150" style="width:150px;max-width:60%;height:auto;border:0;display:block;" />
              </td>
            </tr>

            <tr>
              <td style="padding:24px 40px 0;">
                <h1 style="margin:0;font-size:21px;font-weight:600;line-height:1.35;color:#111827;">${escapeHtml(subject)}</h1>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 40px 8px;">
                ${paragraphs}
              </td>
            </tr>

            <tr>
              <td style="padding:8px 40px 32px;">
                <hr style="border:0;border-top:1px solid #e5e7eb;margin:0;" />
              </td>
            </tr>

            <tr>
              <td style="padding:0 40px 36px;font-size:12px;line-height:1.7;color:#6b7280;">
                <p style="margin:0 0 10px;font-weight:600;color:#374151;">${escapeHtml(brand)}</p>
                <p style="margin:0 0 10px;">Customer purchase tracking for fuel stations and shops.</p>
                <p style="margin:0 0 10px;">
                  <a href="${site}" style="color:#0d9488;text-decoration:none;">${escapeHtml(site.replace(/^https?:\/\//, ""))}</a>
                </p>
                <p style="margin:0;">
                  You're receiving this because your business has an account with ${escapeHtml(brand)}.
                  To stop receiving announcements, turn off promotional email in
                  <a href="${site}/company/settings" style="color:#0d9488;text-decoration:none;">your settings</a>.
                </p>
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
