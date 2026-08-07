import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { Company } from "@/entities/Company";
import { Plan } from "@/entities/Plan";
import { Subscription, type SubscriptionState } from "@/entities/Subscription";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { PaypalService } from "@/services/PaypalService";
import { config } from "@/config/index";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
import { computeEntitlement } from "@/utils/entitlement";
import { returningRows } from "@/utils/db";
import { logger } from "@/utils/logger";

export interface SubscribeResult {
  subscriptionId: string;
  approvalUrl: string;
  /** When billing starts — today, or when existing paid/trial time runs out. */
  startsAt: Date;
}

export interface SubscriptionStatusResult {
  status: SubscriptionState | "none";
  planId: string | null;
  planName: string | null;
  currentPeriodEnd: Date | null;
  nextBillingTime: Date | null;
  cancelledAt: Date | null;
  /** True while the customer keeps access they have already paid for after cancelling. */
  accessUntilPeriodEnd: boolean;
}

/** PayPal status → ours. Anything unrecognised is left alone rather than guessed at. */
const PAYPAL_STATUS_MAP: Record<string, SubscriptionState> = {
  APPROVAL_PENDING: "pending",
  APPROVED: "pending",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};

export class SubscriptionService {
  private paypalService = new PaypalService();
  private companyRepository = new CompanyRepository();

  /**
   * Starts a subscription and returns the PayPal approval URL.
   *
   * The important part is `startTime`. A customer converting mid-trial, or one with
   * Orders-era time still on the clock, must not be charged until that runs out —
   * otherwise subscribing early costs them the days they already have. So billing
   * starts at whichever is later: now, or their current access end.
   *
   * That single rule covers both coexistence cases, which is why there is no separate
   * migration path for legacy Orders customers: they simply subscribe when they are
   * ready and their remaining paid time is honoured.
   */
  async subscribe(companyId: string, planId: string): Promise<SubscribeResult> {
    const company = await AppDataSource.getRepository(Company).findOne({
      where: { id: companyId },
      relations: ["currentSubscription"],
    });
    if (!company) throw NotFoundError("Company not found");

    const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: planId } });
    if (!plan || !plan.isActive || plan.archivedAt != null) {
      throw NotFoundError("That plan is no longer available.");
    }
    if (!plan.isRecurring || !plan.paypalPlanId) {
      throw BadRequestError("That plan cannot be subscribed to. Please choose another.");
    }

    const live = company.currentSubscription;
    if (live && ["pending", "active", "past_due", "pending_cancel"].includes(live.status)) {
      throw ConflictError(
        "You already have a subscription. Change your plan instead of starting a new one.",
      );
    }

    // Later of now and current access end. PayPal rejects a start time in the past, and
    // "now" as computed here is always a few seconds stale by the time the request
    // lands, so add a small cushion.
    const entitlement = computeEntitlement(company, new Date());
    const earliest = new Date(Date.now() + 60_000);
    const startsAt =
      entitlement.endsAt && entitlement.endsAt > earliest ? entitlement.endsAt : earliest;

    // Create the local row FIRST, inside a transaction. The partial unique index
    // `uq_subscriptions_one_live_per_company` is what stops two tabs both reaching
    // PayPal — the second insert fails before any money is involved.
    const local = await AppDataSource.transaction(async (manager) => {
      const row = manager.getRepository(Subscription).create({
        company: { id: companyId } as Company,
        plan: { id: planId } as Plan,
        status: "pending",
      });
      return manager.getRepository(Subscription).save(row);
    });

    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    try {
      const created = await this.paypalService.createSubscription({
        requestId: `kimates-sub-${local.id}`,
        paypalPlanId: plan.paypalPlanId,
        returnUrl: `${base}/company/billing/success`,
        cancelUrl: `${base}/company/billing/cancel`,
        startTime: startsAt,
        customId: companyId,
      });

      await AppDataSource.getRepository(Subscription).update(local.id, {
        paypalSubscriptionId: created.id,
      });

      logger.info(
        { companyId, planId, subscriptionId: local.id, paypalId: created.id, startsAt },
        "Subscription created, awaiting approval",
      );
      return { subscriptionId: local.id, approvalUrl: created.approvalUrl, startsAt };
    } catch (err) {
      // Leaving a `pending` row behind would trip the one-live-per-company index and
      // permanently block the customer from retrying.
      await AppDataSource.getRepository(Subscription).delete(local.id);
      throw err;
    }
  }

  /**
   * Called when the buyer returns from PayPal.
   *
   * Reads the subscription back from PayPal rather than trusting the redirect: the
   * return URL is attacker-controllable and proves nothing about payment.
   */
  async confirm(
    companyId: string,
    paypalSubscriptionId: string,
  ): Promise<SubscriptionStatusResult> {
    const remote = await this.paypalService.getSubscription(paypalSubscriptionId);
    // A null here means PayPal has never heard of this id — almost always a customer
    // landing back with a hand-edited return URL. Same answer as the ownership check.
    if (!remote) throw NotFoundError("Subscription not found");
    // `custom_id` is set to our company id at creation and echoed back — this is what
    // stops one company confirming another's subscription by guessing an id.
    if (remote.custom_id && remote.custom_id !== companyId) {
      throw NotFoundError("Subscription not found");
    }
    await this.applyRemoteState(paypalSubscriptionId, remote);
    return this.getStatus(companyId);
  }

  /**
   * Writes PayPal's authoritative state onto our row, and extends access when a period
   * is live.
   *
   * Shared by the return-from-approval path and every webhook, so the two cannot
   * diverge — the previous Orders implementation had exactly that split and the webhook
   * half skipped the row lock.
   */
  async applyRemoteState(
    paypalSubscriptionId: string,
    remote: {
      status: string;
      billing_info?: { next_billing_time?: string; failed_payments_count?: number };
    },
    eventTime?: Date,
  ): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      // Raw locking read rather than a QueryBuilder with joins.
      //
      // `setLock("pessimistic_write")` puts FOR UPDATE on the whole statement, and
      // Postgres rejects FOR UPDATE against the nullable side of a LEFT JOIN outright —
      // so the obvious `leftJoinAndSelect("s.company")` version fails at runtime, not
      // at compile time. Selecting the FK column directly locks exactly the one row we
      // intend to and needs no join at all.
      const sub = returningRows<{
        id: string;
        company_id: string;
        status: SubscriptionState;
        last_event_at: Date | null;
      }>(
        await manager.query(
          `SELECT "id", "company_id", "status", "last_event_at"
             FROM "subscriptions"
            WHERE "paypal_subscription_id" = $1
            FOR UPDATE`,
          [paypalSubscriptionId],
        ),
      )[0];
      if (!sub) {
        logger.warn({ paypalSubscriptionId }, "No local subscription for this PayPal id");
        return;
      }

      // PayPal does not guarantee webhook ordering, so an older event can arrive after
      // a newer one. Without this a stale ACTIVATED resurrects a cancelled subscription.
      if (eventTime && sub.last_event_at && eventTime <= new Date(sub.last_event_at)) {
        logger.info(
          { paypalSubscriptionId, eventTime, lastEventAt: sub.last_event_at },
          "Ignoring out-of-order subscription event",
        );
        return;
      }

      let status = PAYPAL_STATUS_MAP[remote.status] ?? sub.status;

      // `past_due` has no PayPal counterpart: PayPal still says ACTIVE while it retries
      // a failed payment inside a period the customer already paid for. Access must not
      // lapse, but the UI needs to warn.
      if (status === "active" && (remote.billing_info?.failed_payments_count ?? 0) > 0) {
        status = "past_due";
      }
      // A local `pending_cancel` outranks PayPal's CANCELLED: we cancelled at PayPal
      // deliberately while keeping the paid-for remainder. Letting the webhook
      // overwrite it would lose the reason the customer still has access.
      if (sub.status === "pending_cancel" && status === "cancelled") {
        status = "pending_cancel";
      }

      const nextBilling = remote.billing_info?.next_billing_time
        ? new Date(remote.billing_info.next_billing_time)
        : null;

      await manager.getRepository(Subscription).update(sub.id, {
        status,
        nextBillingTime: nextBilling,
        ...(eventTime ? { lastEventAt: eventTime } : {}),
        paypalResponse: remote as unknown as Record<string, never>,
      });

      if (status === "active" || status === "past_due") {
        await manager
          .getRepository(Company)
          .update(sub.company_id, { currentSubscription: { id: sub.id } as never });
      }

      logger.info({ paypalSubscriptionId, status }, "Subscription state applied");
    });
  }

  /**
   * Credits one recurring payment: extends access and records it in the ledger.
   *
   * The `paypal_sale_id` partial-unique index is the real guard against
   * double-crediting — PayPal resends PAYMENT.SALE.COMPLETED on retry and guarantees
   * neither ordering nor deduplication, so an application-level check is a race.
   * The insert is attempted and a conflict is treated as "already credited".
   */
  async creditCycle(params: {
    paypalSubscriptionId: string;
    saleId: string;
    amount: string;
    currency: string;
  }): Promise<boolean> {
    return AppDataSource.transaction(async (manager) => {
      // Same reasoning as applyRemoteState: FOR UPDATE cannot be combined with a LEFT
      // JOIN in Postgres, and we only want to lock the subscription row anyway — not
      // the company and plan rows a join would drag in.
      const sub = returningRows<{
        id: string;
        company_id: string;
        plan_id: string;
        duration_days: number;
      }>(
        await manager.query(
          `SELECT s."id", s."company_id", s."plan_id", p."duration_days"
             FROM "subscriptions" s
             JOIN "plans" p ON p."id" = s."plan_id"
            WHERE s."paypal_subscription_id" = $1
            FOR UPDATE OF s`,
          [params.paypalSubscriptionId],
        ),
      )[0];
      if (!sub) {
        logger.warn({ ...params }, "Cycle payment for an unknown subscription");
        return false;
      }

      const inserted = returningRows<{ id: string }>(
        await manager.query(
          `INSERT INTO "payments"
             ("company_id", "plan_id", "subscription_id", "paypal_sale_id",
              "kind", "status", "amount", "currency", "captured_at")
           VALUES ($1, $2, $3, $4, 'subscription_cycle', 'captured', $5, $6, now())
           ON CONFLICT ("paypal_sale_id") WHERE "paypal_sale_id" IS NOT NULL DO NOTHING
           RETURNING "id"`,
          [sub.company_id, sub.plan_id, sub.id, params.saleId, params.amount, params.currency],
        ),
      );

      if (inserted.length === 0) {
        logger.info({ saleId: params.saleId }, "Cycle already credited — ignoring replay");
        return false;
      }

      // Same atomic stacking as the Orders path, so a renewal landing early adds to the
      // remaining time instead of overwriting it.
      const { subscriptionEndsAt } = await this.companyRepository.extendSubscription(
        {
          companyId: sub.company_id,
          planId: sub.plan_id,
          durationDays: sub.duration_days,
          now: new Date(),
        },
        manager,
      );

      await manager.getRepository(Subscription).update(sub.id, {
        status: "active",
        currentPeriodEnd: subscriptionEndsAt,
        // A successful charge clears a past-due state and re-arms the expiry notice,
        // since the deadline has moved.
        currentPeriodStart: new Date(),
      });
      await manager
        .getRepository(Company)
        .update(sub.company_id, { subscriptionEndedNoticeFor: null });

      logger.info(
        { companyId: sub.company_id, saleId: params.saleId, until: subscriptionEndsAt },
        "Subscription cycle credited",
      );
      return true;
    });
  }

  /**
   * Cancels. Access continues to the end of the period already paid for.
   *
   * We call PayPal immediately — there is no cancel-at-period-end — and then
   * deliberately DO NOT touch `companies.subscription_expires_at`, which is what leaves
   * the customer with the time they bought. The trade-off is that PayPal cancellation
   * is terminal: there is no resume, only resubscribe, and the UI says so.
   */
  async cancel(companyId: string, reason: string): Promise<{ accessUntil: Date | null }> {
    const company = await AppDataSource.getRepository(Company).findOne({
      where: { id: companyId },
      relations: ["currentSubscription"],
    });
    const sub = company?.currentSubscription;
    if (!company || !sub || !["active", "past_due", "pending_cancel"].includes(sub.status)) {
      throw NotFoundError("You don't have an active subscription to cancel.");
    }
    if (sub.status === "pending_cancel") {
      return { accessUntil: company.subscriptionExpiresAt };
    }

    if (sub.paypalSubscriptionId) {
      await this.paypalService.cancelSubscription(sub.paypalSubscriptionId, reason);
    }

    await AppDataSource.getRepository(Subscription).update(sub.id, {
      status: "pending_cancel",
      cancelledAt: new Date(),
      cancelReason: reason.slice(0, 255),
    });

    logger.info(
      { companyId, subscriptionId: sub.id, accessUntil: company.subscriptionExpiresAt },
      "Subscription cancelled; access retained to period end",
    );
    return { accessUntil: company.subscriptionExpiresAt };
  }

  /**
   * Upgrade or downgrade.
   *
   * **PayPal does not prorate**: the new price applies from the next billing cycle, not
   * today. The effective date also varies by funding source, so `next_billing_time` is
   * read back from PayPal after the change rather than calculated here — never tell the
   * customer a date we worked out ourselves.
   */
  async changePlan(
    companyId: string,
    newPlanId: string,
  ): Promise<{ approvalUrl: string | null; effectiveFrom: Date | null }> {
    const company = await AppDataSource.getRepository(Company).findOne({
      where: { id: companyId },
      relations: ["currentSubscription"],
    });
    const sub = company?.currentSubscription;
    if (!company || !sub || !["active", "past_due"].includes(sub.status)) {
      throw NotFoundError("You don't have an active subscription to change.");
    }
    if (!sub.paypalSubscriptionId) {
      throw BadRequestError("That subscription is not ready yet. Please try again shortly.");
    }

    const plan = await AppDataSource.getRepository(Plan).findOne({ where: { id: newPlanId } });
    if (!plan || !plan.isActive || plan.archivedAt != null || !plan.paypalPlanId) {
      throw NotFoundError("That plan is no longer available.");
    }
    if (plan.id === sub.plan?.id) {
      throw BadRequestError("You're already on that plan.");
    }

    const base = config.FRONTEND_BASE_URL.replace(/\/$/, "");
    const revised = await this.paypalService.reviseSubscription({
      subscriptionId: sub.paypalSubscriptionId,
      paypalPlanId: plan.paypalPlanId,
      returnUrl: `${base}/company/billing/success`,
      cancelUrl: `${base}/company/billing`,
    });

    // Only record the new plan once PayPal has accepted it outright. When approval is
    // still required, the plan changes on return — writing it now would show the
    // customer a plan they have not agreed to and might abandon.
    let effectiveFrom: Date | null = null;
    if (!revised.approvalUrl) {
      const remote = await this.paypalService.getSubscription(sub.paypalSubscriptionId);
      effectiveFrom = remote?.billing_info?.next_billing_time
        ? new Date(remote.billing_info.next_billing_time)
        : null;
      await AppDataSource.getRepository(Subscription).update(sub.id, {
        plan: { id: plan.id } as never,
        nextBillingTime: effectiveFrom,
      });
    }

    logger.info(
      { companyId, from: sub.plan?.id, to: plan.id, needsApproval: revised.approvalUrl !== null },
      "Subscription plan change requested",
    );
    return { approvalUrl: revised.approvalUrl, effectiveFrom };
  }

  async getStatus(companyId: string): Promise<SubscriptionStatusResult> {
    const company = await AppDataSource.getRepository(Company).findOne({
      where: { id: companyId },
      relations: ["currentSubscription", "currentSubscription.plan"],
    });
    const sub = company?.currentSubscription;
    if (!sub) {
      return {
        status: "none",
        planId: null,
        planName: null,
        currentPeriodEnd: null,
        nextBillingTime: null,
        cancelledAt: null,
        accessUntilPeriodEnd: false,
      };
    }
    return {
      status: sub.status,
      planId: sub.plan?.id ?? null,
      planName: sub.plan?.name ?? null,
      currentPeriodEnd: sub.currentPeriodEnd,
      nextBillingTime: sub.nextBillingTime,
      cancelledAt: sub.cancelledAt,
      accessUntilPeriodEnd:
        sub.status === "pending_cancel" &&
        company.subscriptionExpiresAt != null &&
        company.subscriptionExpiresAt > new Date(),
    };
  }

  /** Used by admin deactivation — a banned company must stop being charged. */
  async cancelForAdmin(companyId: string, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? AppDataSource.manager).getRepository(Company);
    const company = await repo.findOne({
      where: { id: companyId },
      relations: ["currentSubscription"],
    });
    const sub = company?.currentSubscription;
    if (!sub || !["active", "past_due", "pending", "pending_cancel"].includes(sub.status)) return;

    if (sub.paypalSubscriptionId) {
      await this.paypalService.cancelSubscription(
        sub.paypalSubscriptionId,
        "Account deactivated by KIMates",
      );
    }
    await (manager ?? AppDataSource.manager).getRepository(Subscription).update(sub.id, {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: "Admin deactivation",
    });
    logger.info(
      { companyId, subscriptionId: sub.id },
      "Subscription cancelled by admin deactivation",
    );
  }
}
