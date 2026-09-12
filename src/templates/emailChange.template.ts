import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function shell(title: string, bodyHtml: string, action?: { url: string; label: string }): string {
  const brand = escapeHtml(config.SMTP_FROM_NAME || "KIMates");
  const button = action
    ? `<tr>
              <td align="center" style="padding:0 40px 24px;">
                <a href="${action.url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(action.label)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 24px;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 8px;">Or copy and paste this link into your browser:</p>
                <p style="margin:0;word-break:break-all;color:#374151;">${action.url}</p>
              </td>
            </tr>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
            <tr>
              <td style="padding:32px 40px 16px;">
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                ${bodyHtml}
              </td>
            </tr>
            ${button}
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0;">— ${brand}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Sent to the NEW address: clicking the link is what proves the owner controls it. */
export function renderEmailChangeConfirmEmail(data: {
  confirmUrl: string;
  newEmail: string;
  expiresInHours: number;
}): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = `Confirm your new ${brand} login email`;
  const text = [
    `Someone asked to change the login email of a ${brand} account to ${data.newEmail}.`,
    ``,
    `If that was you, confirm with the link below. It expires in ${data.expiresInHours} hours.`,
    ``,
    data.confirmUrl,
    ``,
    `If it wasn't you, ignore this email and nothing will change.`,
    ``,
    `— ${brand}`,
  ].join("\n");
  const html = shell(
    "Confirm your new login email",
    `<p style="margin:0 0 16px;">Someone asked to change the login email of a ${escapeHtml(brand)} account to <strong>${escapeHtml(data.newEmail)}</strong>.</p>
                <p style="margin:0 0 16px;">If that was you, confirm below. This link expires in <strong>${data.expiresInHours} hours</strong>.</p>
                <p style="margin:0 0 8px;">If it wasn't you, ignore this email and nothing will change.</p>`,
    { url: data.confirmUrl, label: "Confirm new email" },
  );
  return { subject, html, text };
}

/**
 * Sent to the OLD address, twice: when a change is requested and when it completes.
 * The owner of the old mailbox is the one person who can spot a hijack, so neither
 * notice can be skipped.
 */
export function renderEmailChangeNoticeEmail(data: {
  newEmail: string;
  stage: "requested" | "completed";
}): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const supportHint = `If this wasn't you, change your password now and contact ${brand} support.`;
  if (data.stage === "requested") {
    const subject = `A change to your ${brand} login email was requested`;
    const text = [
      `A request was made to change your ${brand} login email to ${data.newEmail}.`,
      ``,
      `Nothing changes until the new address is confirmed.`,
      ``,
      supportHint,
      ``,
      `— ${brand}`,
    ].join("\n");
    const html = shell(
      "Login email change requested",
      `<p style="margin:0 0 16px;">A request was made to change your ${escapeHtml(brand)} login email to <strong>${escapeHtml(data.newEmail)}</strong>.</p>
                <p style="margin:0 0 16px;">Nothing changes until the new address is confirmed.</p>
                <p style="margin:0;">${escapeHtml(supportHint)}</p>`,
    );
    return { subject, html, text };
  }
  const subject = `Your ${brand} login email was changed`;
  const text = [
    `Your ${brand} login email is now ${data.newEmail}. This address can no longer be used to sign in.`,
    ``,
    `All sessions were signed out.`,
    ``,
    supportHint,
    ``,
    `— ${brand}`,
  ].join("\n");
  const html = shell(
    "Your login email was changed",
    `<p style="margin:0 0 16px;">Your ${escapeHtml(brand)} login email is now <strong>${escapeHtml(data.newEmail)}</strong>. This address can no longer be used to sign in.</p>
                <p style="margin:0 0 16px;">All sessions were signed out.</p>
                <p style="margin:0;">${escapeHtml(supportHint)}</p>`,
  );
  return { subject, html, text };
}
