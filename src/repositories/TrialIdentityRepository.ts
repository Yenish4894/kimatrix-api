import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { TrialIdentity, type TrialIdentifierType } from "@/entities/TrialIdentity";

export interface IdentityClaim {
  type: TrialIdentifierType;
  hash: string;
  preview: string;
}

export class TrialIdentityRepository {
  private getRepo(manager?: EntityManager) {
    return manager
      ? manager.getRepository(TrialIdentity)
      : AppDataSource.getRepository(TrialIdentity);
  }

  /**
   * Read-only eligibility probe. Cheap, and safe to call on an unauthenticated path
   * because it takes hashes, never raw identifiers, and answers only true/false.
   *
   * This is advisory: `claim()` is the authority. Between this check and the claim,
   * another registration can take the same identifier.
   */
  async anyClaimed(hashes: string[], manager?: EntityManager): Promise<boolean> {
    if (hashes.length === 0) return false;
    const found = await this.getRepo(manager)
      .createQueryBuilder("ti")
      .select("1")
      .where("ti.identifier_hash IN (:...hashes)", { hashes })
      .andWhere("ti.released_at IS NULL")
      .limit(1)
      .getRawOne<Record<string, unknown>>();
    return found != null;
  }

  /**
   * Claims every identifier for the company, all-or-nothing.
   *
   * `ON CONFLICT ... DO NOTHING` rather than catching a 23505: registration and
   * verification both run inside a transaction, and in Postgres an unhandled unique
   * violation aborts the *whole* transaction, not just the failing statement. Letting
   * a duplicate raise would therefore roll back the entire registration — which
   * violates the rule that a repeat identifier must never block signup, only the free
   * trial. `DO NOTHING` reports the conflict as an absent RETURNING row instead.
   *
   * `RETURNING id` is what makes this atomic and race-proof: whoever's INSERT lands
   * first gets the row back, and a concurrent claimant gets nothing. It is the same
   * pattern as the payment capture claim.
   *
   * @returns true only if EVERY identifier was claimed by this call. A partial claim
   * means someone else holds one of them, so the caller must not grant a trial. The
   * rows we did insert stay — they are genuinely this company's identifiers, and the
   * caller's own eligibility flag records that no trial was granted.
   */
  async claim(
    claims: IdentityClaim[],
    companyId: string,
    manager: EntityManager,
  ): Promise<boolean> {
    if (claims.length === 0) return true;

    let claimed = 0;
    for (const c of claims) {
      const result = (await manager.query(
        `INSERT INTO "trial_identities"
           ("identifier_type", "identifier_hash", "identifier_preview", "company_id")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("identifier_hash") WHERE "released_at" IS NULL DO NOTHING
         RETURNING "id"`,
        [c.type, c.hash, c.preview, companyId],
      )) as { id: string }[];
      if (result.length > 0) claimed++;
    }
    return claimed === claims.length;
  }

  async findByCompany(companyId: string, manager?: EntityManager): Promise<TrialIdentity[]> {
    return this.getRepo(manager).find({
      where: { company: { id: companyId } },
      order: { claimedAt: "DESC" },
    });
  }

  /**
   * Hands an identifier back. The partial unique index is `WHERE released_at IS NULL`,
   * so stamping `released_at` frees the slot without destroying the audit trail —
   * which is the whole reason the index is partial rather than plain.
   *
   * @returns true if this call performed the release.
   */
  async release(
    id: string,
    releasedByUserId: string,
    reason: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const result = await this.getRepo(manager)
      .createQueryBuilder()
      .update(TrialIdentity)
      .set({
        releasedAt: () => "now()",
        releasedBy: { id: releasedByUserId },
        releaseReason: reason,
      })
      .where("id = :id", { id })
      .andWhere("released_at IS NULL")
      .execute();
    return (result.affected ?? 0) === 1;
  }
}
