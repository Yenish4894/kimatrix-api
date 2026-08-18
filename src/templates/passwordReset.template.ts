import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

interface PasswordResetTemplateData {
  resetUrl: string;
  expiresInMinutes: number;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderPasswordResetEmail(data: PasswordResetTemplateData): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = `Reset your ${brand} password`;
  const safeUrl = data.resetUrl;
  const minutes = data.expiresInMinutes;

  const text = [
    `You requested a password reset for your ${brand} account.`,
    ``,
    `Click the link below to set a new password. The link expires in ${minutes} minutes.`,
    ``,
    safeUrl,
    ``,
    `If you didn't request this, you can safely ignore this email — your current password will continue to work.`,
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
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">Reset your password</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                <p style="margin:0 0 16px;">We received a request to reset the password for your ${escapeHtml(brand)} account.</p>
                <p style="margin:0 0 24px;">Click the button below to set a new password. This link expires in <strong>${minutes} minutes</strong>.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 40px 24px;">
                <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">Reset password</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 24px;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 8px;">Or copy and paste this link into your browser:</p>
                <p style="margin:0;word-break:break-all;color:#374151;">${safeUrl}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 8px;">If you didn't request this, you can safely ignore this email — your current password will continue to work.</p>
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
