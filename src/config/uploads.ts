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
 *
 * The legacy Office formats (.doc, .xls) were removed: they are OLE containers that
 * carry VBA macros with nothing in the name to say so, and are the classic way to mail
 * malware. .docx/.xlsx cannot hold macros (that is .docm/.xlsm), and the content check
 * below also refuses one that has a macro project stuffed inside anyway.
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
  ".docx",
  ".xlsx",
] as const;

export function isAllowedAttachment(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (ATTACHMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

const startsWith = (bytes: Buffer, signature: string | number[], offset = 0): boolean => {
  const sig =
    typeof signature === "string" ? Buffer.from(signature, "latin1") : Buffer.from(signature);
  return (
    bytes.length >= offset + sig.length && bytes.subarray(offset, offset + sig.length).equals(sig)
  );
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ELF = [0x7f, 0x45, 0x4c, 0x46];

/** Formats that must never arrive under a text extension. */
function looksBinaryExecutableOrContainer(bytes: Buffer): boolean {
  return (
    startsWith(bytes, "MZ") || // Windows executable
    startsWith(bytes, ELF) ||
    startsWith(bytes, ZIP) ||
    startsWith(bytes, OLE) ||
    startsWith(bytes, "%PDF-")
  );
}

/**
 * An Office Open XML file of the expected kind, with no macro project inside.
 *
 * Entry names in a zip are stored uncompressed in both the local headers and the
 * central directory, so a byte search finds them without unzipping. `vbaProject.bin`
 * is where Office keeps macros; a .docx carrying one is a renamed .docm.
 */
function isCleanOoxml(bytes: Buffer, partPrefix: "word/" | "xl/"): boolean {
  return (
    startsWith(bytes, ZIP) &&
    bytes.includes("[Content_Types].xml", 0, "latin1") &&
    bytes.includes(partPrefix, 0, "latin1") &&
    !bytes.includes("vbaProject.bin", 0, "latin1")
  );
}

/**
 * Whether a file's CONTENT is what its extension claims.
 *
 * The extension allowlist alone trusted the name the uploader chose, so `payload.exe`
 * renamed to `notice.pdf` went out to every company. This checks the leading bytes
 * (the "magic number") against the format, and for text types that it is not a binary
 * in disguise. Pass the whole file: the OOXML macro check has to see the zip directory.
 */
export function contentMatchesExtension(filename: string, bytes: Buffer): boolean {
  switch (path.extname(filename).toLowerCase()) {
    case ".pdf":
      return startsWith(bytes, "%PDF-");
    case ".png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case ".jpg":
    case ".jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case ".gif":
      return startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a");
    case ".webp":
      return startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8);
    case ".docx":
      return isCleanOoxml(bytes, "word/");
    case ".xlsx":
      return isCleanOoxml(bytes, "xl/");
    case ".csv":
    case ".txt": {
      // Text has no magic number, so check the opposite: no NUL bytes (no real CSV or
      // TXT contains one) and no known binary header.
      const head = bytes.subarray(0, 64 * 1024);
      return !head.includes(0) && !looksBinaryExecutableOrContainer(head);
    }
    default:
      return false;
  }
}

/** Human-readable size, for error copy that tells the admin what actually happened. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
