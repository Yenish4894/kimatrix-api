import fs from "node:fs/promises";
import path from "node:path";
import { ATTACHMENT_DIR, ATTACHMENT_RETENTION_DAYS } from "@/config/uploads";
import { logger } from "@/utils/logger";

/**
 * Deletes bulk-email attachments once nothing can still need them.
 *
 * Files are kept for a while rather than removed at send time: a job that fails is
 * retried with backoff, and a bulk send to a large list can still be working through
 * the queue minutes later. Deleting on "send complete" would race the retries and
 * strip the attachment off the tail of the very sends most likely to need it.
 *
 * The retention window is far longer than any retry sequence, so by the time a file
 * is removed no job can still be holding a reference to it.
 */
export async function cleanupExpiredAttachments(now = new Date()): Promise<number> {
  const cutoff = now.getTime() - ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await fs.readdir(ATTACHMENT_DIR);
  } catch {
    // No directory yet means nothing has ever been uploaded.
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    const file = path.join(ATTACHMENT_DIR, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      await fs.unlink(file);
      removed++;
    } catch (err) {
      // One unreadable file must not stop the sweep.
      logger.warn({ err, file }, "Could not clean up attachment");
    }
  }

  if (removed > 0) {
    logger.info({ removed, retentionDays: ATTACHMENT_RETENTION_DAYS }, "Attachments cleaned up");
  }
  return removed;
}
