import { AppDataSource } from "data-source";
import type { EntityManager } from "typeorm";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
import type { Plan } from "@/entities/Plan";
import { PlanRepository, type PlanPatch } from "@/repositories/PlanRepository";
import { AuditService } from "@/services/AuditService";
import { SettingsService } from "@/services/SettingsService";
import { logger } from "@/utils/logger";

export interface PlanDto {
  id: string;
  name: string;
  description: string | null;
  durationDays: number;
  price: string;
  currency: string;
  isActive: boolean;
  isPopular: boolean;
  sortOrder: number;
  archivedAt: Date | null;
  supersededByPlanId: string | null;
  supersedesPlanId: string | null;
  /** Admin-only hints so the UI can explain why an action is unavailable. */
  hasPayments?: boolean;
  hasSubscribers?: boolean;
}

export interface CreatePlanInput {
  name: string;
  description?: string | null;
  durationDays: number;
  price: string;
  isPopular?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

export interface UpdatePlanInput {
  name?: string;
  description?: string | null;
  durationDays?: number;
  price?: string;
  isPopular?: boolean;
  sortOrder?: number;
}

export interface Actor {
  id: string;
  email: string;
}

export const PLAN_DURATION_MIN = 1;
export const PLAN_DURATION_MAX = 3650;
export const PLAN_PRICE_MAX = 1_000_000;

function toDto(plan: Plan): PlanDto {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    durationDays: plan.durationDays,
    price: plan.price,
    currency: plan.currency,
    isActive: plan.isActive,
    isPopular: plan.isPopular,
    sortOrder: plan.sortOrder,
    archivedAt: plan.archivedAt,
    supersededByPlanId: plan.supersededBy?.id ?? null,
    supersedesPlanId: plan.supersedes?.id ?? null,
  };
}

/** Normalize to a fixed 2dp string so "10", "10.0" and "10.00" compare equal. */
function normalizePrice(raw: string): string {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw BadRequestError("Enter a valid price.");
  }
  if (value > PLAN_PRICE_MAX) {
    throw BadRequestError(`The price cannot exceed ${PLAN_PRICE_MAX.toLocaleString("en-US")}.`);
  }
  return value.toFixed(2);
}

function assertDuration(days: number): void {
  if (!Number.isInteger(days) || days < PLAN_DURATION_MIN || days > PLAN_DURATION_MAX) {
    throw BadRequestError(
      `The plan duration must be between ${PLAN_DURATION_MIN} and ${PLAN_DURATION_MAX} days.`,
    );
  }
}

export class PlanService {
  private planRepository = new PlanRepository();
  private settingsService = new SettingsService();
  private auditService = new AuditService();

  /**
   * Admin catalogue — everything, annotated with whether each plan can safely be
   * edited in place. The UI uses these flags to explain why an edit will create a new
   * version rather than presenting a silent surprise.
   */
  async listForAdmin(): Promise<PlanDto[]> {
    const plans = await this.planRepository.findAllForAdminWithUsage();
    return plans.map((plan) => ({
      ...toDto(plan),
      hasPayments: plan.hasPayments,
      hasSubscribers: plan.hasSubscribers,
    }));
  }

  async create(input: CreatePlanInput, actor: Actor): Promise<PlanDto> {
    assertDuration(input.durationDays);
    const price = normalizePrice(input.price);
    const name = input.name.trim();
    if (!name) throw BadRequestError("Enter a name for the plan.");
    if (input.isPopular === true && input.isActive === false) {
      throw BadRequestError(
        "A hidden plan can't be the most popular one — put it on sale or clear the badge.",
      );
    }

    return AppDataSource.transaction(async (manager) => {
      // Currency is never chosen per-plan; it always follows the platform setting so
      // the billing page can't end up showing two currencies side by side.
      const currency = await this.settingsService.getPlatformCurrency(manager);

      const created = await this.planRepository.create(
        {
          name,
          description: input.description?.trim() || null,
          durationDays: input.durationDays,
          price,
          currency,
          isActive: input.isActive ?? true,
          isPopular: input.isPopular ?? false,
          sortOrder: input.sortOrder ?? input.durationDays,
        },
        manager,
      );

      if (created.isPopular) {
        await this.clearOtherPopular(created.id, manager);
      }

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "plan.create",
          entityType: "plan",
          entityId: created.id,
          after: toDto(created) as unknown as Record<string, unknown>,
        },
        manager,
      );

      logger.info({ planId: created.id, actorId: actor.id }, "Plan created");
      return toDto(created);
    });
  }

  /**
   * Edit a plan.
   *
   * Cosmetic fields (name, description, sortOrder, isPopular) are updated in place.
   *
   * Price and duration are **versioned**: the existing plan is archived and a
   * successor created, linked in both directions. Editing them in place would rewrite
   * history, because `payments.plan_id` points at this row — a receipt for a R250
   * purchase would start claiming the new price. It would also desync us from PayPal,
   * whose billing plans cannot be repriced.
   *
   * A plan with no billing history yet is edited in place: there is nothing to
   * rewrite, and versioning it would litter the catalogue with dead rows.
   */
  async update(planId: string, input: UpdatePlanInput, actor: Actor): Promise<PlanDto> {
    if (input.durationDays !== undefined) assertDuration(input.durationDays);
    const nextPrice = input.price !== undefined ? normalizePrice(input.price) : undefined;

    return AppDataSource.transaction(async (manager) => {
      // Locked, not a plain read: two concurrent price edits would otherwise both pass
      // the archived check, both create a successor, and both archive the same
      // predecessor — leaving an orphaned live plan nobody knows about.
      const plan = await this.planRepository.findByIdForUpdate(planId, manager);
      if (!plan) throw NotFoundError("That plan no longer exists.");
      if (plan.archivedAt) {
        throw BadRequestError(
          "This plan has been replaced by a newer version and can no longer be edited.",
        );
      }

      // A hidden plan wearing the badge would strip it from the plan customers can
      // actually see, leaving the billing page with no "Most Popular" and no clue why.
      if (input.isPopular === true && !plan.isActive) {
        throw BadRequestError(
          "Put this plan on sale before featuring it — a hidden plan can't be the most popular one.",
        );
      }

      const before = toDto(plan) as unknown as Record<string, unknown>;

      const priceChanged = nextPrice !== undefined && nextPrice !== plan.price;
      const durationChanged =
        input.durationDays !== undefined && input.durationDays !== plan.durationDays;
      const billingChanged = priceChanged || durationChanged;

      // Only asked when it can actually change the outcome.
      const carriesHistory = billingChanged
        ? await this.planRepository.carriesHistory(plan.id, manager)
        : false;

      // ── In-place edit ──────────────────────────────────────────────────────
      if (!billingChanged || !carriesHistory) {
        const patch: PlanPatch = {};
        if (input.name !== undefined) {
          const name = input.name.trim();
          if (!name) throw BadRequestError("Enter a name for the plan.");
          patch.name = name;
        }
        if (input.description !== undefined) patch.description = input.description?.trim() || null;
        if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
        if (input.isPopular !== undefined) patch.isPopular = input.isPopular;
        if (nextPrice !== undefined) patch.price = nextPrice;
        if (input.durationDays !== undefined) patch.durationDays = input.durationDays;

        // Sort order defaults to the duration on create. If it was never overridden and
        // the duration changes, carry it across — otherwise editing a 30-day plan to 365
        // days leaves it sorted as if it were still 30, with no way to notice.
        if (
          input.sortOrder === undefined &&
          input.durationDays !== undefined &&
          plan.sortOrder === plan.durationDays
        ) {
          patch.sortOrder = input.durationDays;
        }

        await this.planRepository.update(plan.id, patch, manager);
        if (patch.isPopular) await this.clearOtherPopular(plan.id, manager);

        const updated = await this.planRepository.findByIdAnyState(plan.id, manager);
        await this.auditService.record(
          {
            actorUserId: actor.id,
            actorEmail: actor.email,
            action: "plan.update",
            entityType: "plan",
            entityId: plan.id,
            before,
            after: updated ? (toDto(updated) as unknown as Record<string, unknown>) : null,
            note: billingChanged
              ? "Price/duration edited in place — plan had no billing history"
              : null,
          },
          manager,
        );
        return toDto(updated!);
      }

      // ── Versioned edit ─────────────────────────────────────────────────────
      const successor = await this.planRepository.create(
        {
          name: input.name?.trim() || plan.name,
          description:
            input.description !== undefined ? input.description?.trim() || null : plan.description,
          durationDays: input.durationDays ?? plan.durationDays,
          price: nextPrice ?? plan.price,
          // Deliberately inherits the predecessor's currency rather than the current
          // platform setting: the successor is a reprice of the same product, and a
          // currency switch is blocked while sellable plans exist in the old one.
          currency: plan.currency,
          isActive: plan.isActive,
          isPopular: input.isPopular ?? plan.isPopular,
          // Same reasoning as the in-place branch — keep an auto-derived sort order in
          // step with a changed duration.
          sortOrder:
            input.sortOrder ??
            (input.durationDays !== undefined && plan.sortOrder === plan.durationDays
              ? input.durationDays
              : plan.sortOrder),
          supersedes: { id: plan.id } as Plan,
        } as Partial<Plan>,
        manager,
      );

      // Archive the predecessor. It stays readable so historical payments and any
      // company still mid-subscription continue to resolve correctly.
      await this.planRepository.update(
        plan.id,
        {
          isActive: false,
          archivedAt: new Date(),
          isPopular: false,
          supersededBy: { id: successor.id },
        },
        manager,
      );

      if (successor.isPopular) await this.clearOtherPopular(successor.id, manager);

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "plan.version",
          entityType: "plan",
          entityId: successor.id,
          before,
          after: toDto(successor) as unknown as Record<string, unknown>,
          note: `Superseded plan ${plan.id} (price/duration changed on a plan with billing history)`,
        },
        manager,
      );

      logger.info(
        { previousPlanId: plan.id, newPlanId: successor.id, actorId: actor.id },
        "Plan versioned",
      );
      return toDto(successor);
    });
  }

  /**
   * Enable or disable a plan.
   *
   * Disabling only stops NEW purchases. Companies already on the plan keep their
   * subscription until it expires — their access is governed by
   * `companies.subscription_expires_at`, which this never touches.
   */
  async setActive(planId: string, isActive: boolean, actor: Actor): Promise<PlanDto> {
    return AppDataSource.transaction(async (manager) => {
      const plan = await this.planRepository.findByIdAnyState(planId, manager);
      if (!plan) throw NotFoundError("That plan no longer exists.");

      if (plan.archivedAt && isActive) {
        throw BadRequestError(
          "This plan has been replaced by a newer version and cannot be re-enabled.",
        );
      }
      if (plan.isActive === isActive) return toDto(plan);

      if (!isActive) {
        // Refuse to leave the catalogue empty. With no active plan the billing page has
        // nothing to sell, and every expired company is stranded with no way to pay.
        const activeCount = await this.planRepository.countActiveForUpdate(manager);
        if (activeCount <= 1) {
          throw ConflictError(
            "This is the only plan customers can currently buy. Create or enable another plan before disabling this one.",
          );
        }
      }

      await this.planRepository.update(
        plan.id,
        isActive ? { isActive: true } : { isActive: false, isPopular: false },
        manager,
      );

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: isActive ? "plan.enable" : "plan.disable",
          entityType: "plan",
          entityId: plan.id,
          before: { isActive: plan.isActive },
          after: { isActive },
        },
        manager,
      );

      logger.info({ planId: plan.id, isActive, actorId: actor.id }, "Plan availability changed");
      const updated = await this.planRepository.findByIdAnyState(plan.id, manager);
      return toDto(updated!);
    });
  }

  /** Only one plan may wear the "Most Popular" badge at a time. */
  private async clearOtherPopular(keepPlanId: string, manager: EntityManager): Promise<void> {
    await manager.query(
      `UPDATE "plans" SET "is_popular" = false WHERE "id" <> $1 AND "is_popular" = true`,
      [keepPlanId],
    );
  }
}
