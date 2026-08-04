import type { EntityManager } from "typeorm";
import {
  TrialIdentityRepository,
  type IdentityClaim,
} from "@/repositories/TrialIdentityRepository";
import type { TrialIdentifierType } from "@/entities/TrialIdentity";
import { hashIdentifier, maskIdentifier } from "@/utils/identity";
import { logger } from "@/utils/logger";

export interface TrialIdentifiers {
  /** The account login address — the only one email verification actually proves. */
  loginEmail: string;
  contactEmail: string;
  contactPhone: string;
}

export class TrialIdentityService {
  private repository = new TrialIdentityRepository();

  /**
   * Which identifiers a company burns by taking a free trial.
   *
   * Deliberately NOT claimed:
   *  - `whatsapp_number` — optional, so it is trivially omitted to dodge the check,
   *    and it is frequently a shared or agency number, so claiming it would burn a
   *    third party's trial.
   *  - `customers.mobile` — QR submitters are members of the public. Someone who once
   *    scanned a code at a filling station must not be barred from later registering
   *    their own business.
   */
  private toClaims(identifiers: TrialIdentifiers): IdentityClaim[] {
    const raw: [TrialIdentifierType, string][] = [
      ["email", identifiers.loginEmail],
      ["email", identifiers.contactEmail],
      ["phone", identifiers.contactPhone],
    ];

    const claims: IdentityClaim[] = [];
    const seen = new Set<string>();
    for (const [type, value] of raw) {
      if (!value) continue;
      const hash = hashIdentifier(type, value);
      // Login and contact email are usually the same address; canonicalisation makes
      // that visible. Two identical hashes in one claim set would make the second
      // INSERT conflict with the first and read as "already taken by someone else".
      if (seen.has(hash)) continue;
      seen.add(hash);
      claims.push({ type, hash, preview: maskIdentifier(type, value) });
    }
    return claims;
  }

  /**
   * Advisory pre-check used at registration so the response can tell the user
   * up front whether a trial is coming. `claimForTrial` re-decides authoritatively.
   */
  async isEligible(identifiers: TrialIdentifiers, manager?: EntityManager): Promise<boolean> {
    const claims = this.toClaims(identifiers);
    return !(await this.repository.anyClaimed(
      claims.map((c) => c.hash),
      manager,
    ));
  }

  /**
   * The authoritative claim, made at the moment the trial is granted.
   *
   * Claiming here rather than at registration is a deliberate departure from the
   * original plan. The trial clock starts on email verification, and claiming earlier
   * would let anyone burn a stranger's trial by typing their address into a
   * registration form they never confirm. Claiming at grant means an identifier is
   * only ever consumed by someone who proved control of the login address.
   *
   * @returns true if the caller may grant the trial.
   */
  async claimForTrial(
    identifiers: TrialIdentifiers,
    companyId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    const claims = this.toClaims(identifiers);
    const granted = await this.repository.claim(claims, companyId, manager);
    if (!granted) {
      // Never log the identifier, and never tell the caller *which* one matched —
      // on an unauthenticated flow that is an enumeration oracle.
      logger.info({ companyId }, "Trial refused — an identifier has already used its trial");
    }
    return granted;
  }
}
