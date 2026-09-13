import type { BulkEmailLog } from "@/entities/BulkEmailLog";
import { BadRequestError } from "@/errors/index";
import { BulkEmailLogRepository } from "@/repositories/BulkEmailLogRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { EmailService } from "@/services/EmailService";
import { logger } from "@/utils/logger";
import { BULK_EMAIL_MAX_RECIPIENTS } from "@/validation/schemas/admin.schema";

/** Admin announcements to companies (and hand-typed extra addresses). */
export class AdminBulkEmailService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly emailService = new EmailService(),
    private readonly bulkEmailLogRepository = new BulkEmailLogRepository(),
  ) {}

  async sendBulkEmail(
    admin: { id: string; email: string },
    subject: string,
    body: string,
    companyIds: string[],
    extraEmails: string[] = [],
    attachment?: { path: string; filename: string; size: number },
  ): Promise<{ recipientCount: number; logId: string; skippedOptedOut: number }> {
    if (!subject.trim()) throw BadRequestError("Subject is required.");
    if (!body.trim()) throw BadRequestError("Body is required.");
    if (!companyIds.length && !extraEmails.length) {
      throw BadRequestError("Select at least one company, or add an email address.");
    }

    // Fetch only the owner emails for the requested companies.
    const found = companyIds.length
      ? await this.companyRepository.findByIdsWithOwner(companyIds)
      : [];
    // Enforced here, not left to whoever ticks the boxes: the footer of every one of
    // these emails promises that opting out stops them, so an admin selecting an
    // opted-out company must not be able to break that promise. Extra addresses typed
    // by hand are not companies and have no preference to honour.
    const optedIn = found.filter((c) => c.promoEmailOptIn !== false);
    const skippedOptedOut = found.length - optedIn.length;

    // A company whose owner row is missing would throw on `.owner.email` and take the
    // whole broadcast down with it. Skip it and deliver to everyone else instead.
    const companies = optedIn.filter((c) => c.owner?.email);
    if (companies.length < optedIn.length) {
      logger.warn(
        { requested: companyIds.length, deliverable: companies.length },
        "Bulk email: some companies have no owner email and were skipped",
      );
    }

    // One address may be both a company owner and typed into the extra box. Sending
    // the same announcement twice to the same person looks like a broken system, so
    // the address decides identity, not which list it came from.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const address of [...companies.map((c) => c.owner.email), ...extraEmails]) {
      const key = address.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      recipients.push(address.trim());
    }

    if (!recipients.length) {
      throw BadRequestError(
        skippedOptedOut > 0
          ? "Every selected company has opted out of these emails."
          : "No valid recipients found.",
      );
    }
    // Counted after dedupe, on what would actually be sent. The schema caps each list;
    // this caps their sum (SEC-7). Every recipient is one job through our only mailbox.
    if (recipients.length > BULK_EMAIL_MAX_RECIPIENTS) {
      throw BadRequestError(
        `A bulk email can go to at most ${BULK_EMAIL_MAX_RECIPIENTS} recipients at a time; this one would reach ${recipients.length}. Split it into smaller sends.`,
      );
    }

    // Enqueue one job per recipient so individual failures don't block others. Every
    // job points at the same file on disk rather than carrying a copy of it.
    await Promise.all(
      recipients.map((to) =>
        this.emailService.enqueueBulkEmail({
          to,
          subject: subject.trim(),
          body: body.trim(),
          ...(attachment
            ? { attachment: { path: attachment.path, filename: attachment.filename } }
            : {}),
        }),
      ),
    );

    const saved = await this.bulkEmailLogRepository.create({
      subject: subject.trim(),
      body: body.trim(),
      sentByEmail: admin.email,
      attachmentFilename: attachment?.filename ?? null,
      attachmentSize: attachment?.size ?? null,
      // What actually went out, not what was asked for — the two differ whenever a
      // company is skipped or an address appears in both lists.
      recipientCount: recipients.length,
      recipientIds: companies.map((c) => c.id),
      extraEmails,
      sentBy: { id: admin.id } as never,
    });

    logger.info(
      {
        logId: saved.id,
        adminId: admin.id,
        recipientCount: recipients.length,
        companies: companies.length,
        skippedOptedOut,
        extra: extraEmails.length,
      },
      "Bulk email enqueued",
    );
    return { recipientCount: recipients.length, logId: saved.id, skippedOptedOut };
  }

  async listBulkEmailLogs(
    page: number,
    limit: number,
  ): Promise<{ items: BulkEmailLog[]; total: number }> {
    return this.bulkEmailLogRepository.list(page, limit);
  }
}
