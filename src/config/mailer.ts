import nodemailer, { type Transporter } from "nodemailer";
import { config } from "@/config/index";
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
