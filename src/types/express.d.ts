import type { Logger } from "pino";
import type { User } from "@/entities/User";
import type { Company } from "@/entities/Company";
import type { Entitlement } from "@/utils/entitlement";

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      user?: User;
      company?: Company;
      /** Set alongside `company` by companyMiddleware. Computed fresh per request. */
      entitlement?: Entitlement;
      rawBody?: Buffer;
    }
  }
}

export {};
