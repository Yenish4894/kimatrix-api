import { AppDataSource } from "data-source";
import type { SubscriptionStatus } from "@/entities/Company";
import { BadRequestError, NotFoundError } from "@/errors/index";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { AuditService } from "@/services/AuditService";
import type { TransactionRunner } from "@/utils/db";
import { computeEntitlement } from "@/utils/entitlement";
import { logger } from "@/utils/logger";

/** The admin comp: free access, forever or until a date. */
export class AdminCompService {
  constructor(
    private readonly companyRepository = new CompanyRepository(),
    private readonly auditService = new AuditService(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

  /**
   * Sets or clears the admin comp — the explicit "free, forever or until X" override,
   * and the only thing that grants access without payment.
   *
   * A reason is required for a grant. Comping is a money decision, and an unexplained
   * one is indistinguishable from a mistake when someone reads it back in six months.
   */
  async setComp(
    companyId: string,
    params: {
      isComped: boolean;
      compedUntil: Date | null;
      reason: string | null;
      drawSpins?: number;
    },
    actor: { id: string; email: string },
  ): Promise<{ status: SubscriptionStatus; hasAccess: boolean }> {
    const adminUserId = actor.id;
    return this.db.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      if (!company) throw NotFoundError("Company not found");
      if (params.isComped && !params.reason?.trim()) {
        throw BadRequestError("Please give a reason for this complimentary access.");
      }

      const compedUntil = params.isComped ? params.compedUntil : null;

      // Omitting spins leaves them as they are; revoking the comp revokes them too.
      const drawSpins = params.isComped ? (params.drawSpins ?? company.compDrawSpins ?? 0) : 0;
      // The draw window opens when spins are first granted and stays put while they
      // are merely adjusted — otherwise topping up a spin would quietly re-admit the
      // customers who already won.
      const keepWindow =
        company.isComped && company.compDrawSpins > 0 && company.compDrawSpinsGrantedAt != null;
      const drawSpinsGrantedAt =
        drawSpins === 0 ? null : keepWindow ? company.compDrawSpinsGrantedAt : new Date();

      await this.companyRepository.setComp(
        {
          companyId,
          isComped: params.isComped,
          compedUntil,
          reason: params.isComped ? (params.reason?.trim() ?? null) : null,
          grantedByUserId: params.isComped ? adminUserId : null,
          drawSpins,
          drawSpinsGrantedAt,
        },
        manager,
      );

      const entitlement = computeEntitlement(
        { ...company, isComped: params.isComped, compedUntil },
        new Date(),
      );
      await this.companyRepository.setEntitlementState(
        companyId,
        { isActive: entitlement.hasAccess, subscriptionStatus: entitlement.status },
        manager,
      );

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: params.isComped ? "company.comp" : "company.uncomp",
          entityType: "company",
          entityId: companyId,
          before: {
            isComped: company.isComped,
            compedUntil: company.compedUntil ? new Date(company.compedUntil).toISOString() : null,
            drawSpins: company.compDrawSpins,
          },
          after: {
            isComped: params.isComped,
            compedUntil: compedUntil ? new Date(compedUntil).toISOString() : null,
            drawSpins,
          },
          note: params.isComped ? (params.reason?.trim() ?? null) : null,
        },
        manager,
      );

      logger.info(
        { companyId, adminUserId, isComped: params.isComped, compedUntil },
        params.isComped ? "Complimentary access granted" : "Complimentary access revoked",
      );
      return { status: entitlement.status, hasAccess: entitlement.hasAccess };
    });
  }
}
