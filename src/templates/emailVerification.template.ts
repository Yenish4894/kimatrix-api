import { config } from "@/config/index";

interface EmailVerificationTemplateData {
  verifyUrl: string;
  expiresInMinutes: number;
  trialDurationDays: number;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderEmailVerificationEmail(data: EmailVerificationTemplateData): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = `Confirm your email to start your ${brand} free trial`;
  const safeUrl = data.verifyUrl;
  const minutes = data.expiresInMinutes;
  const days = data.trialDurationDays;
  const hours = Math.round(minutes / 60);
  const expiryLabel = minutes >= 120 ? `${hours} hours` : `${minutes} minutes`;

  const text = [
    `Welcome to ${brand}.`,
    ``,
    `Confirm your email address to activate your account and start your ${days}-day free trial.`,
    `Your trial clock only starts once you confirm, so you won't lose any of it.`,
    ``,
    `This link expires in ${expiryLabel}.`,
    ``,
    safeUrl,
    ``,
    `If you didn't create a ${brand} account, you can safely ignore this email.`,
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
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">Confirm your email</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                <p style="margin:0 0 16px;">Welcome to ${escapeHtml(brand)}. Confirm your email address to activate your account and start your <strong>${days}-day free trial</strong>.</p>
                <p style="margin:0 0 24px;">Your trial clock only starts once you confirm, so none of it is spent waiting on this email. The link expires in <strong>${escapeHtml(expiryLabel)}</strong>.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 40px 24px;">
                <a href="${safeUrl}" style="display:inline-block;background:#0891B2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">Confirm email &amp; start trial</a>
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
                <p style="margin:0 0 8px;">If you didn't create a ${escapeHtml(brand)} account, you can safely ignore this email.</p>
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

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
