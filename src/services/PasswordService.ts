import bcrypt from "bcryptjs";
import { config } from "@/config/index";

/**
 * A throwaway hash at the live cost factor, used to burn the same CPU time on a
 * missing account as on a real one. Computed once, lazily — generating it at import
 * time would add a bcrypt round to every process start, including short-lived CLI runs.
 */
let decoyHash: Promise<string> | null = null;

export class PasswordService {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, config.BCRYPT_ROUNDS);
  }

  async verify(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }

  /**
   * Call instead of `verify` when there is no user to compare against.
   *
   * Without it, login answered a non-existent email in a few milliseconds and an
   * existing one in a few hundred — bcrypt at 12 rounds is essentially the whole
   * response time, so the gap is readable from anywhere and needs no statistics. That
   * makes login a reliable account-enumeration oracle over the entire customer list,
   * which is the reconnaissance step before credential stuffing or a phishing run.
   *
   * Always returns false; the return value exists only so call sites read naturally.
   */
  async verifyAgainstDecoy(plain: string): Promise<false> {
    decoyHash ??= bcrypt.hash("password-that-is-never-valid", config.BCRYPT_ROUNDS);
    await bcrypt.compare(plain, await decoyHash);
    return false;
  }
}
