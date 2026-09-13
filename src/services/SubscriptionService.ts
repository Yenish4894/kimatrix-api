import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import type { SubscriptionState } from "@/entities/Subscription";
import { AuditLogRepository } from "@/repositories/AuditLogRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { PaymentRepository } from "@/repositories/PaymentRepository";
import { PlanRepository } from "@/repositories/PlanRepository";
import { SubscriptionRepository } from "@/repositories/SubscriptionRepository";
import { PaypalService } from "@/services/PaypalService";
import { NotificationService } from "@/services/NotificationService";
import { config } from "@/config/index";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
import { computeEntitlement } from "@/utils/entitlement";
import type { TransactionRunner } from "@/utils/db";
import { logger } from "@/utils/logger";
import { billingStartTime, saleMatchesPlan, subscriptionBelongsTo } from "@/utils/paypalBilling";

/** Same system-actor convention as PaypalWebhookService: no user, this marker instead. */
const SYSTEM_ACTOR_EMAIL = "system:paypal-webhook";

export interface SubscribeResult {
  subscriptionId: string;
  approvalUrl: string;
  /** When billing starts — now, or a day before existing paid/trial time runs out. */
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
  constructor(
    private readonly paypalService = new PaypalService(),
    private readonly companyRepository = new CompanyRepository(),
    private readonly notificationService = new NotificationService(),
    private readonly subscriptionRepository = new SubscriptionRepository(),
    private readonly planRepository = new PlanRepository(),
    private readonly paymentRepository = new PaymentRepository(),
    private readonly auditLogRepository = new AuditLogRepository(),
    private readonly db: TransactionRunner = AppDataSource,
  ) {}

  /**
   * Starts a subscription and returns the PayPal approval URL.
   *
   * The important part is `startTime`. A customer converting mid-trial, or one with
   * Orders-era time still on the clock, must not be charged until that runs out —
   * otherwise subscribing early costs them the days they already have. So billing
   * starts at whichever is later: now, or 24 hours before their current access end.
   * The day's lead stops access lapsing while the charge's webhook is in flight; it is
   * free to the customer because creditCycle stacks each period onto existing time.
   *
   * That single rule covers both coexistence cases, which is why there is no separate
   * migration path for legacy Orders customers: they simply subscribe when they are
   * ready and their remaining paid time is honoured.
   */
  async subscribe(companyId: string, planId: string): Promise<SubscribeResult> {
    const company = await this.companyRepository.findByIdWithRelations(companyId, [
      "currentSubscription",
    ]);
    if (!company) throw NotFoundError("Company not found");

    const plan = await this.planRepository.findByIdIncludingInactive(planId);
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

    // A day BEFORE the current access end, never before now. Charging exactly at the
    // end left access lapsed between expiry and PAYMENT.SALE.COMPLETED, so the paywall
    // hit paying customers every cycle. Charging early costs them nothing: creditCycle
    // stacks each period onto the existing expiry (and onto a live trial's end).
    const entitlement = computeEntitlement(company, new Date());
    const startsAt = billingStartTime(entitlement.endsAt, new Date());

    // Create the local row FIRST, inside a transaction. The partial unique index
    // `uq_subscriptions_one_live_per_company` is what stops two tabs both reaching
    // PayPal — the second insert fails before any money is involved.
    const local = await this.db.transaction(async (manager) =>
      this.subscriptionRepository.createPending(companyId, planId, manager),
    );

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

      await this.subscriptionRepository.update(local.id, {
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
      await this.subscriptionRepository.delete(local.id);
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
    // Ownership from OUR row first. It records the company before the buyer is sent to
    // PayPal, so every legitimate confirm finds it. Relying on PayPal's `custom_id`
    // alone skipped the check whenever PayPal left it out, letting one company confirm
    // (and apply the state of) another's subscription. Checking locally first also
    // means a guessed id costs no PayPal call.
    const localCompanyId =
      await this.subscriptionRepository.findCompanyIdByPaypalId(paypalSubscriptionId);
    if (!subscriptionBelongsTo(localCompanyId, null, companyId)) {
      throw NotFoundError("Subscription not found");
    }

    const remote = await this.paypalService.getSubscription(paypalSubscriptionId);
    // A null here means PayPal has never heard of this id — almost always a customer
    // landing back with a hand-edited return URL. Same answer as the ownership check.
    if (!remote) throw NotFoundError("Subscription not found");
    // `custom_id` is set to our company id at creation and echoed back; when present it
    // must agree with our row too.
    if (!subscriptionBelongsTo(localCompanyId, remote.custom_id, companyId)) {
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
      plan_id?: string;
      billing_info?: { next_billing_time?: string; failed_payments_count?: number };
    },
    eventTime?: Date,
  ): Promise<void> {
    await this.db.transaction(async (manager) => {
      // Raw locking read rather than a QueryBuilder with joins — see
      // SubscriptionRepository: FOR UPDATE cannot sit on the nullable side of a LEFT
      // JOIN, and selecting the FK column directly locks exactly the one row we intend.
      const sub = await this.subscriptionRepository.lockByPaypalId(paypalSubscriptionId, manager);
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

      await this.subscriptionRepository.update(
        sub.id,
        {
          status,
          nextBillingTime: nextBilling,
          ...(eventTime ? { lastEventAt: eventTime } : {}),
          paypalResponse: remote as unknown as Record<string, never>,
        },
        manager,
      );

      // PayPal is the authority on which plan the subscription is on. Without this, a
      // plan change that needed buyer approval was never recorded locally — changePlan
      // defers the write until approval and nothing else wrote it. Mapped through
      // `plans.paypal_plan_id`; when several versions share one PayPal plan, the one
      // already stored wins, otherwise the newest. No match leaves the row alone.
      if (remote.plan_id) {
        await this.subscriptionRepository.syncPlanFromPaypal(sub.id, remote.plan_id, manager);
      }

      if (status === "active" || status === "past_due") {
        await this.companyRepository.setCurrentSubscription(sub.company_id, sub.id, manager);
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
    // Which plan this sale belongs to. The stored plan_id is not reliable for that: a
    // plan change that needs no approval rewrites it at once, and one that does is
    // recorded only when PayPal reports it. Read PayPal's view BEFORE the transaction
    // so no connection is held across the HTTP call. Failure is not fatal — we fall
    // back to the stored plan, which is exactly the previous behaviour.
    const remotePlanId = await this.paypalService
      .getSubscription(params.paypalSubscriptionId)
      .then((r) => r?.plan_id ?? null)
      .catch((err: unknown) => {
        logger.warn({ err, ...params }, "Could not read subscription plan; using stored plan");
        return null;
      });

    // The newly credited payment, or null for an unknown subscription or a replay. Only a
    // real credit gets a receipt, and only once the credit has committed.
    const credited = await this.db.transaction(
      async (
        manager: EntityManager,
      ): Promise<{
        paymentId: string;
        companyId: string;
      } | null> => {
        // Same reasoning as applyRemoteState: FOR UPDATE cannot be combined with a LEFT
        // JOIN in Postgres, and we only want to lock the subscription row anyway — not
        // the company and plan rows a join would drag in.
        const locked = await this.subscriptionRepository.lockForCycleCredit(
          params.paypalSubscriptionId,
          manager,
        );
        if (!locked) {
          logger.warn({ ...params }, "Cycle payment for an unknown subscription");
          return null;
        }

        // Candidates: the plan PayPal reports, the stored plan, and the plan of the last
        // cycle we credited (the pre-change plan, when a change just happened). The sale
        // amount is the only real evidence of which plan was charged, so a price match
        // wins; otherwise PayPal's plan, then the stored one.
        const plan = await this.subscriptionRepository.findCyclePlan(
          {
            remotePlanId,
            storedPlanId: locked.plan_id,
            subscriptionId: locked.id,
            amount: params.amount,
            currency: params.currency,
          },
          manager,
        );
        if (!plan) {
          // Unreachable while plans are never deleted (FK RESTRICT), but a throw here
          // makes PayPal retry rather than silently dropping a paid cycle.
          throw new Error(`creditCycle: no plan for subscription ${locked.id}`);
        }

        // The sale must have paid a candidate plan's exact price, in its currency. The
        // query above already prefers a price match, so reaching a mismatch here means
        // NO plan this subscription could be on costs what was charged. Crediting a
        // full period for it anyway (as this used to) meant a wrong PayPal plan, a
        // currency slip or a partial charge bought the same access as the real price.
        //
        // Not credited, and not thrown either: a throw makes PayPal retry the webhook
        // forever for a sale that will never match. Recorded for an admin instead —
        // the money has moved, so a human must decide between crediting and refunding.
        if (!saleMatchesPlan(params, plan)) {
          await this.auditLogRepository.insertAmountMismatchOnce(manager, {
            actorEmail: SYSTEM_ACTOR_EMAIL,
            saleId: params.saleId.slice(0, 64),
            before: { planId: plan.id, price: plan.price, currency: plan.currency },
            after: {
              amount: params.amount,
              currency: params.currency,
              subscriptionId: locked.id,
              paypalSubscriptionId: params.paypalSubscriptionId,
              companyId: locked.company_id,
            },
            note: "Recurring sale NOT credited: amount/currency differs from the plan. Check PayPal, then credit or refund.",
          });
          logger.error(
            {
              saleId: params.saleId,
              companyId: locked.company_id,
              subscriptionId: locked.id,
              paid: { amount: params.amount, currency: params.currency },
              expected: { planId: plan.id, price: plan.price, currency: plan.currency },
            },
            "Recurring sale does not match the plan price — NOT credited, needs review",
          );
          return null;
        }

        const sub = {
          id: locked.id,
          company_id: locked.company_id,
          plan_id: plan.id,
          duration_days: plan.duration_days,
        };
        // Renewals are charged a day before access ends, and the first charge may land
        // while a trial is still running. Trial time lives in `trial_ends_at`, not in
        // `subscription_expires_at`, so floor the stacking point at the trial end or the
        // converting customer loses the rest of their trial.
        const trialEnd = locked.trial_ends_at ? new Date(locked.trial_ends_at) : null;
        const creditFrom = trialEnd && trialEnd > new Date() ? trialEnd : new Date();

        const inserted = await this.paymentRepository.insertSubscriptionCycle(
          {
            companyId: sub.company_id,
            planId: sub.plan_id,
            subscriptionId: sub.id,
            saleId: params.saleId,
            amount: params.amount,
            currency: params.currency,
          },
          manager,
        );

        if (inserted.length === 0) {
          logger.info({ saleId: params.saleId }, "Cycle already credited — ignoring replay");
          return null;
        }

        // Extend only after the unique sale insert succeeds. A PayPal webhook replay
        // must not add a second period before it discovers that the sale was known.
        const { subscriptionStartsAt, subscriptionEndsAt } =
          await this.companyRepository.extendSubscription(
            {
              companyId: sub.company_id,
              planId: sub.plan_id,
              durationDays: sub.duration_days,
              now: creditFrom,
            },
            manager,
          );
        await this.paymentRepository.setSubscriptionWindow(
          inserted[0]!.id,
          subscriptionStartsAt,
          subscriptionEndsAt,
          manager,
        );

        await this.subscriptionRepository.update(
          sub.id,
          {
            status: "active",
            currentPeriodEnd: subscriptionEndsAt,
            // A successful charge clears a past-due state and re-arms the expiry notice,
            // since the deadline has moved.
            currentPeriodStart: subscriptionStartsAt,
          },
          manager,
        );
        await this.companyRepository.clearSubscriptionEndedNotice(sub.company_id, manager);

        logger.info(
          { companyId: sub.company_id, saleId: params.saleId, until: subscriptionEndsAt },
          "Subscription cycle credited",
        );
        return { paymentId: inserted[0]!.id, companyId: sub.company_id };
      },
    );

    // Never awaited, never throws: the webhook must answer 2xx for a credited cycle even
    // if the receipt cannot be queued.
    if (credited) void this.notificationService.sendPaymentReceipt(credited);
    return credited !== null;
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
    const company = await this.companyRepository.findByIdWithRelations(companyId, [
      "currentSubscription",
    ]);
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

    await this.subscriptionRepository.update(sub.id, {
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
    const company = await this.companyRepository.findByIdWithRelations(companyId, [
      "currentSubscription",
    ]);
    const sub = company?.currentSubscription;
    if (!company || !sub || !["active", "past_due"].includes(sub.status)) {
      throw NotFoundError("You don't have an active subscription to change.");
    }
    if (!sub.paypalSubscriptionId) {
      throw BadRequestError("That subscription is not ready yet. Please try again shortly.");
    }

    const plan = await this.planRepository.findByIdIncludingInactive(newPlanId);
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
      await this.subscriptionRepository.update(sub.id, {
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
    const company = await this.companyRepository.findByIdWithRelations(companyId, [
      "currentSubscription",
      "currentSubscription.plan",
    ]);
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
    const company = await this.companyRepository.findByIdWithRelations(
      companyId,
      ["currentSubscription"],
      manager,
    );
    const sub = company?.currentSubscription;
    if (!sub || !["active", "past_due", "pending", "pending_cancel"].includes(sub.status)) return;

    if (sub.paypalSubscriptionId) {
      await this.paypalService.cancelSubscription(
        sub.paypalSubscriptionId,
        "Account deactivated by KIMates",
      );
    }
    await this.subscriptionRepository.update(
      sub.id,
      {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: "Admin deactivation",
      },
      manager,
    );
    logger.info(
      { companyId, subscriptionId: sub.id },
      "Subscription cancelled by admin deactivation",
    );
  }
}
