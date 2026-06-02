import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "@/config/index";
import { logger } from "@/utils/logger";

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range";
const HIBP_TIMEOUT_MS = 3000;

export class PasswordService {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, config.BCRYPT_ROUNDS);
  }

  async verify(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }

  /**
   * HIBP k-anonymity check. Only the first 5 chars of the SHA-1 hash are sent.
   * Fails open on network error — doesn't block users if HIBP is down.
   */
  async isCompromised(plain: string): Promise<boolean> {
    const sha1 = crypto.createHash("sha1").update(plain).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
      const res = await fetch(`${HIBP_RANGE_URL}/${prefix}`, {
        headers: { "Add-Padding": "true" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn({ status: res.status }, "HIBP check failed (non-2xx)");
        return false;
      }
      const body = await res.text();
      for (const line of body.split("\n")) {
        const [hashSuffix] = line.split(":");
        if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) {
          return true;
        }
      }
      return false;
    } catch (err) {
      logger.warn({ err }, "HIBP check failed — proceeding (fail-open)");
      return false;
    }
  }
}
