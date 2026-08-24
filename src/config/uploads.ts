import path from "node:path";

/**
 * Where bulk-email attachments live, and what is allowed in.
 *
 * Attachments are stored on disk ONCE and referenced by every job, rather than being
 * carried inside the job payload. A bulk send enqueues one job per recipient, so a
 * 10 MB file embedded in each would put a gigabyte through Redis for a hundred
 * recipients — and Redis holds it in memory.
 */
export const ATTACHMENT_DIR =
  process.env["ATTACHMENT_DIR"] ?? path.resolve(process.cwd(), "uploads", "bulk-email");

/** 10 MB, as specified. nginx must allow more than this or the upload dies at the proxy. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** How long an uploaded file survives before the cleanup job removes it. */
export const ATTACHMENT_RETENTION_DAYS = 7;

/**
 * Extensions an admin may attach.
 *
 * An allowlist, not a blocklist. The file is sent to every company on the platform, so
 * the failure mode of getting this wrong is mailing an executable to every customer —
 * and most mail providers would reject the message and damage the sending domain's
 * reputation along the way.
 */
export const ATTACHMENT_ALLOWED_EXTENSIONS = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".csv",
  ".txt",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
] as const;

export function isAllowedAttachment(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (ATTACHMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/** Human-readable size, for error copy that tells the admin what actually happened. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
