import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import {
  ATTACHMENT_DIR,
  ATTACHMENT_MAX_BYTES,
  formatBytes,
  isAllowedAttachment,
} from "@/config/uploads";
import { BadRequestError } from "@/middleware/errorHandler";

fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ATTACHMENT_DIR),
  filename: (_req, file, cb) => {
    // The stored name is generated, never the client's. A caller-controlled filename
    // reaching the filesystem is how "../../.env" becomes a write primitive; the
    // original is kept in the database for display only.
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: ATTACHMENT_MAX_BYTES,
    files: 1,
    // Without this a request with thousands of tiny fields still costs memory.
    fields: 10,
  },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedAttachment(file.originalname)) {
      cb(BadRequestError("That file type can't be attached. Use a PDF, image, or document."));
      return;
    }
    cb(null, true);
  },
}).single("file");

/**
 * Accepts one attachment, and turns multer's own errors into product copy.
 *
 * Multer throws `LIMIT_FILE_SIZE` with the message "File too large", which tells an
 * admin nothing about what the limit is or how far over they are. The limit is the
 * single most likely thing to go wrong here, so it gets a real sentence.
 */
export function attachmentUpload(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (err: unknown) => {
    if (!err) {
      discardOnFailure(req, res);
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(
          BadRequestError(
            `That file is larger than the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit. Try compressing it or sending a link instead.`,
          ),
        );
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        next(BadRequestError("Only one attachment can be sent per email."));
        return;
      }
    }
    next(err);
  });
}

/**
 * Deletes the uploaded file if the request does not end in a successful send.
 *
 * Multer writes to disk before any validation runs, so a request rejected afterwards —
 * no recipients, a blank subject, a service error — left its file behind. The weekly
 * sweep eventually collected it, but an admin fumbling the form three times with 10 MB
 * files meant 30 MB sitting there for a week for no reason.
 *
 * Keyed on the response status rather than on an error object, so it covers every way
 * a request can fail, including ones added later.
 */
function discardOnFailure(req: Request, res: Response): void {
  res.on("finish", () => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    // 2xx means the send was accepted and the queued jobs still need this file.
    if (!file || (res.statusCode >= 200 && res.statusCode < 300)) return;

    void unlink(file.path).catch(() => {
      // Nothing to do about it here; the nightly sweep is the backstop.
    });
  });
}
