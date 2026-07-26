import bcrypt from "bcryptjs";
import { config } from "@/config/index";

export class PasswordService {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, config.BCRYPT_ROUNDS);
  }

  async verify(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }
}
