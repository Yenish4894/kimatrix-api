import type { Logger } from "pino";
import type { User } from "@/entities/User";
import type { Company } from "@/entities/Company";

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: User;
      company?: Company;
      rawBody?: Buffer;
    }
  }
}

export {};
