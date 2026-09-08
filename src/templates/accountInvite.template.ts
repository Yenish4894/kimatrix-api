import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

interface AccountInviteTemplateData {
  /** Where the owner sets their first password. A password-reset link under the hood. */
  setPasswordUrl: string;
  companyName: string;
  expiresInHours: number;
  /** Null when the complimentary access has no end date. */
  freeUntil: Date | null;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Sent when an admin creates a company on someone's behalf.
 *
 * Distinct from the password-reset email even though it rides the same token: the
 * recipient never asked for anything and may not know the account exists, so "reset
 * your password" would read as a phishing attempt. This says who made the account and
 * why they are hearing from us.
 */
export function renderAccountInviteEmail(data: AccountInviteTemplateData): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = `Your ${brand} account is ready`;
  const url = data.setPasswordUrl;
  const company = data.companyName;
  const hours = data.expiresInHours;
  const freeLine = data.freeUntil
    ? `Your account is free to use until ${data.freeUntil.toLocaleDateString("en-ZA", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}.`
    : `Your account is free to use, with no end date.`;

  const text = [
    `Your ${brand} account for ${company} has been set up for you.`,
    ``,
    `Choose a password to get in:`,
    url,
    ``,
    `This link expires in ${hours} hours. If it lapses, use "Forgot password" on the`,
    `sign-in page and we will send you a fresh one.`,
    ``,
    freeLine,
    ``,
    `Once you are in you can print your QR code and start recording customer purchases.`,
    ``,
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
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">Your account is ready</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                <p style="margin:0 0 16px;">A ${escapeHtml(brand)} account for <strong>${escapeHtml(company)}</strong> has been set up for you. Choose a password and you are in.</p>
                <p style="margin:0 0 24px;">${escapeHtml(freeLine)}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 40px 24px;">
                <a href="${url}" style="display:inline-block;background:#0891B2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">Choose your password</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 24px;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 8px;">Or copy and paste this link into your browser:</p>
                <p style="margin:0 0 16px;word-break:break-all;color:#374151;">${url}</p>
                <p style="margin:0;">This link expires in <strong>${escapeHtml(String(hours))} hours</strong>. If it lapses, use &ldquo;Forgot password&rdquo; on the sign-in page for a fresh one.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 8px;">Once you are in you can print your QR code and start recording customer purchases.</p>
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
