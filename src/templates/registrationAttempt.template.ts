import { config } from "@/config/index";
import { escapeHtml } from "@/utils/html";

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Sent to an EXISTING account's login address when someone submits the registration
 * form with it.
 *
 * Registration answers identically whether or not the address is taken (so the form
 * cannot be used to check who is a customer). This email is how the real owner still
 * finds out: they get told here, in their own inbox, instead of on the page.
 *
 * Deliberately carries nothing from the form: the submitter controls it, and echoing
 * a company name or username into someone else's mailbox would make this a way to
 * send them arbitrary text.
 */
export function renderRegistrationAttemptEmail(data: {
  loginUrl: string;
  resetUrl: string;
}): RenderedEmail {
  const brand = config.SMTP_FROM_NAME || "KIMates";
  const subject = `Someone tried to create a ${brand} account with your email`;

  const text = [
    `Someone tried to create a ${brand} account with this email address. You already have an account, so no new account was created.`,
    ``,
    `If it was you, log in or reset your password:`,
    ``,
    `Log in: ${data.loginUrl}`,
    `Reset your password: ${data.resetUrl}`,
    ``,
    `If it wasn't you, you can ignore this email. Nothing about your account has changed.`,
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
                <h1 style="margin:0;font-size:20px;font-weight:600;color:#111827;">You already have an account</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 16px;font-size:15px;line-height:1.6;color:#374151;">
                <p style="margin:0 0 16px;">Someone tried to create a ${escapeHtml(brand)} account with this email address. You already have an account, so no new account was created.</p>
                <p style="margin:0 0 8px;">If it was you, log in or reset your password.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 40px 24px;">
                <a href="${escapeHtml(data.loginUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;margin:0 4px 8px;">Log in</a>
                <a href="${escapeHtml(data.resetUrl)}" style="display:inline-block;background:#ffffff;color:#111827;text-decoration:none;padding:11px 27px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;font-weight:600;margin:0 4px 8px;">Reset password</a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.6;color:#6b7280;">
                <p style="margin:0 0 8px;">If it wasn't you, you can ignore this email. Nothing about your account has changed.</p>
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
