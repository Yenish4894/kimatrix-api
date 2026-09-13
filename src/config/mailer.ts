import nodemailer, { type Transporter } from "nodemailer";
import { config } from "@/config/index";
import { recordSmtpOutcome } from "@/services/SmtpHealthStore";
import { failureOutcome, successOutcome, type SmtpSendSource } from "@/utils/smtpHealth";
import { logger } from "@/utils/logger";

let transporter: Transporter | null = null;

export function getMailer(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth:
      config.SMTP_USER && config.SMTP_PASS
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined,
  });
  logger.info({ host: config.SMTP_HOST, port: config.SMTP_PORT }, "Mailer transport created");
  return transporter;
}

export function fromAddress(): string {
  return config.SMTP_FROM_NAME
    ? `${config.SMTP_FROM_NAME} <${config.SMTP_FROM_EMAIL}>`
    : config.SMTP_FROM_EMAIL;
}

/** Values that must never reach the dashboard from an echoed SMTP reply. */
export function smtpSecrets(): string[] {
  return [config.SMTP_PASS, config.SMTP_USER];
}

type MailMessage = Parameters<Transporter["sendMail"]>[0];

/**
 * The one way the app sends email. Records the outcome of every attempt (see
 * SmtpHealthStore) and then behaves exactly like `sendMail`: resolves with the info,
 * or rethrows the original error so BullMQ's retry logic is untouched.
 *
 * Goes through here rather than `getMailer().sendMail` so the admin status reflects
 * what the server actually did with our mail — verify() alone kept reporting healthy
 * while Hostinger was refusing every send.
 */
export async function sendMail(
  message: MailMessage,
  source: SmtpSendSource = "job",
): Promise<void> {
  try {
    await getMailer().sendMail(message);
    await recordSmtpOutcome(successOutcome(source));
  } catch (err) {
    await recordSmtpOutcome(failureOutcome(err, source, smtpSecrets()));
    throw err;
  }
}
