import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { logger } from "@/utils/logger";
import { PlanRepository } from "@/repositories/PlanRepository";
import { PaymentRepository } from "@/repositories/PaymentRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { PaypalService } from "@/services/PaypalService";
import { PaypalWebhookService } from "@/services/PaypalWebhookService";
import { SettingsService } from "@/services/SettingsService";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
import type { Plan } from "@/entities/Plan";
import { computeEntitlement } from "@/utils/entitlement";
import { orderAmount, spinWindowClosed } from "@/utils/spinAddon";

export interface PlanDto {
  /** Lucky draw spins the plan includes, so the billing page can say so. */
  drawSpins: number;
  id: string;
  name: string;
  description: string | null;
  durationDays: number;
  price: string;
  currency: string;
  /** Drives the "Most Popular" badge. Replaces the frontend's hardcoded 30-day check. */
  isPopular: boolean;
  sortOrder: number;
  /**
   * Whether this plan can be bought as a recurring subscription.
   *
   * Drives which flow the Pay button takes. False for legacy plans and for any plan
   * whose PayPal billing plan has not been synced yet — those still go through the
   * one-time Orders path, so an unsynced plan degrades to the old behaviour rather
   * than failing at checkout.
   */
  isRecurring: boolean;
}

export interface InitiatePaymentResult {
  paymentId: string;
  paypalOrderId: string;
  approvalUrl: string;
}

export interface CapturePaymentResult {
  paymentId: string;
  kind: "order" | "spin_addon";
  subscriptionStartsAt: Date;
  subscriptionEndsAt: Date;
}

export class PaymentService {
  private planRepository = new PlanRepository();
  private paymentRepository = new PaymentRepository();
  private companyRepository = new CompanyRepository();
  private paypalService = new PaypalService();
  private paypalWebhookService = new PaypalWebhookService();
  private settingsService = new SettingsService();

  async getPlans(): Promise<PlanDto[]> {
    const plans = await this.planRepository.findAllActive();
    return plans.map(this.toDto);
  }

  /**
   * Price of one lucky draw spin add-on, in USD.
   *
   * Its own endpoint rather than a field on `/plans`: changing `/plans` from an array to
   * an object broke whichever frontend was live while the other half deployed — the
   * homepage pricing and the billing page both call `.find` on that response.
   */
  async getSpinAddonPrice(): Promise<{ priceUsd: number }> {
    return { priceUsd: await this.settingsService.getSpinAddonPriceUsd() };
  }

  async initiatePayment(
    companyId: string,
    planId: string,
    spinQuantity = 0,
  ): Promise<InitiatePaymentResult> {
    const plan = await this.planRepository.findById(planId);
    if (!plan || !plan.isActive || plan.archivedAt != null) {
      throw NotFoundError("That plan is no longer available.");
    }
    if (!Number.isInteger(spinQuantity) || spinQuantity < 0 || spinQuantity > 100) {
      throw BadRequestError("Choose between 0 and 100 spins.");
    }
    if (spinQuantity > 0 && plan.currency !== "USD") {
      throw BadRequestError("Lucky Draw spins are priced in USD and require a USD plan.");
    }

    const spinAddonPriceUsd = await this.settingsService.getSpinAddonPriceUsd();
    const amount = orderAmount(Number(plan.price), spinQuantity, spinAddonPriceUsd);

    const returnUrl = `${config.FRONTEND_BASE_URL}/company/billing/success`;
    const cancelUrl = `${config.FRONTEND_BASE_URL}/company/billing/cancel`;

    const order = await this.paypalService.createOrder({
      amount,
      currency: plan.currency,
      referenceId: `${companyId}:${planId}:spins:${spinQuantity}`,
      returnUrl,
      cancelUrl,
    });

    const approvalLink = order.links.find((l) => l.rel === "approve");
    if (!approvalLink)
      throw BadRequestError("Payment could not be initiated. Please try again or contact support.");

    const payment = await this.paymentRepository.create({
      companyId,
      planId,
      paypalOrderId: order.id,
      status: "pending",
      amount,
      currency: plan.currency,
      // Plans no longer include spins. This is the paid checkout add-on snapshot.
      drawSpins: spinQuantity,
    });

    logger.info({ companyId, planId, paypalOrderId: order.id }, "PayPal order created");

    return {
      paymentId: payment.id,
      paypalOrderId: order.id,
      approvalUrl: approvalLink.href,
    };
  }

  /** Buy more spins without extending access. Only a company in a paid plan period can do this. */
  async initiateSpinPurchase(
    companyId: string,
    spinQuantity: number,
  ): Promise<InitiatePaymentResult> {
    if (!Number.isInteger(spinQuantity) || spinQuantity < 1 || spinQuantity > 100) {
      throw BadRequestError("Choose between 1 and 100 spins.");
    }

    // The add-on joins the paid window running right now, taking that payment's exact
    // start and end. LuckyDrawRepository pools captured payments by window, so matching
    // it is what puts these spins in the same draw as the plan's.
    //
    // It used to take the start from the current payment but the end from
    // `companies.subscription_expires_at`. With a second plan stacked after this one that
    // is the end of the FUTURE plan: the window matched nothing, formed its own pool, and
    // spanned both plans.
    const [current] = (await AppDataSource.query(
      `SELECT p."plan_id" AS plan_id,
              p."subscription_starts_at" AS starts_at,
              p."subscription_ends_at" AS ends_at
         FROM "payments" p
        WHERE p."company_id" = $1
          AND p."status" = 'captured'
          AND p."kind" IN ('order', 'subscription_cycle')
          AND p."subscription_starts_at" <= now()
          AND p."subscription_ends_at" > now()
        ORDER BY p."subscription_starts_at" DESC
        LIMIT 1`,
      [companyId],
    )) as { plan_id: string; starts_at: Date; ends_at: Date }[];
    const company = await this.companyRepository.findById(companyId);
    if (!company || !current || !computeEntitlement(company, new Date()).hasAccess) {
      throw BadRequestError("You can add spins only while a paid plan is active.");
    }
    const plan = await this.planRepository.findById(current.plan_id);
    if (!plan) throw NotFoundError("Current plan not found.");
    if (plan.currency !== "USD") {
      throw BadRequestError("Lucky Draw spins are priced in USD and require a USD plan.");
    }

    const spinAddonPriceUsd = await this.settingsService.getSpinAddonPriceUsd();
    const amount = orderAmount(0, spinQuantity, spinAddonPriceUsd);
    const returnUrl = `${config.FRONTEND_BASE_URL}/company/billing/success`;
    const cancelUrl = `${config.FRONTEND_BASE_URL}/company/billing/cancel`;
    const order = await this.paypalService.createOrder({
      amount,
      currency: "USD",
      referenceId: `${companyId}:spin-addon:${spinQuantity}`,
      returnUrl,
      cancelUrl,
    });
    const approvalLink = order.links.find((l) => l.rel === "approve");
    if (!approvalLink)
      throw BadRequestError("Spin purchase could not be initiated. Please try again.");

    const payment = await this.paymentRepository.create({
      companyId,
      planId: plan.id,
      paypalOrderId: order.id,
      status: "pending",
      kind: "spin_addon",
      amount,
      currency: "USD",
      drawSpins: spinQuantity,
      subscriptionStartsAt: new Date(current.starts_at),
      subscriptionEndsAt: new Date(current.ends_at),
    });
    return { paymentId: payment.id, paypalOrderId: order.id, approvalUrl: approvalLink.href };
  }

  async capturePayment(companyId: string, paypalOrderId: string): Promise<CapturePaymentResult> {
    // Quick non-locking check — avoids acquiring a row lock for already-completed payments.
    //
    // Scoped to the caller's company. `findByPaypalOrderId` is not company-scoped, and
    // without the ownership test this branch answered for somebody else's payment: pass
    // a captured order id belonging to another company and it returned that payment's id
    // and subscription dates. PayPal order ids are not secret — they arrive as a query
    // parameter on the return URL — so this was reachable, not theoretical. The
    // `claimForCapture` path below already scopes by company; this shortcut did not, and
    // the retry branch a few lines down checks ownership explicitly. Same rule, all three.
    const existing = await this.paymentRepository.findByPaypalOrderId(paypalOrderId);
    if (existing?.status === "captured" && existing.company.id === companyId) {
      return {
        paymentId: existing.id,
        kind: existing.kind === "spin_addon" ? "spin_addon" : "order",
        subscriptionStartsAt: existing.subscriptionStartsAt!,
        subscriptionEndsAt: existing.subscriptionEndsAt!,
      };
    }

    // ── 1. Claim the row atomically: pending -> capturing. ────────────────────
    // Only one caller can win this transition, which is what previously required
    // holding a row lock across the whole PayPal round trip.
    const claimed = await this.paymentRepository.claimForCapture(paypalOrderId, companyId);
    if (!claimed) {
      // Re-read to produce a precise error rather than a generic one.
      const current = await this.paymentRepository.findByPaypalOrderId(paypalOrderId);
      if (!current || current.company.id !== companyId) throw NotFoundError("Payment not found.");
      if (current.status === "captured") {
        return {
          paymentId: current.id,
          kind: current.kind === "spin_addon" ? "spin_addon" : "order",
          subscriptionStartsAt: current.subscriptionStartsAt!,
          subscriptionEndsAt: current.subscriptionEndsAt!,
        };
      }
      if (current.status === "capturing") {
        throw ConflictError("This payment is already being processed. Please wait a moment.");
      }
      throw BadRequestError("This payment cannot be captured.");
    }

    // A spin add-on belongs to one plan window. If the buyer sat on PayPal's approval
    // page until that window closed, capturing would charge them for spins that can no
    // longer be used — so stop here, before any money moves. An order never approved
    // is simply abandoned at PayPal.
    if (claimed.kind === "spin_addon" && spinWindowClosed(claimed.subscriptionEndsAt, new Date())) {
      await this.paymentRepository.updateStatus(claimed.id, "failed", {
        reason: "plan_window_ended_before_capture",
      });
      throw BadRequestError(
        "Your plan period ended before this payment went through, so you have not been charged. Renew your plan to buy spins.",
      );
    }

    // ── 2. Network I/O, holding NO database connection. ───────────────────────
    // This call takes up to 15s. Inside a transaction it pinned one of only ten pool
    // connections for the duration, and an abort AFTER PayPal debited the buyer rolled
    // the row back to `pending` — money taken, nothing granted.
    let capture: Awaited<ReturnType<PaypalService["captureOrder"]>>;
    try {
      capture = await this.paypalService.captureOrder(paypalOrderId);
    } catch (err) {
      // Deliberately left in `capturing`, NOT `failed`: PayPal may well have taken the
      // money and we simply never heard back. The webhook finalizes it, and it would
      // skip a row we had marked failed.
      logger.error(
        { err, paypalOrderId, companyId },
        "Capture request failed after claim — payment left in `capturing` for webhook reconciliation",
      );
      throw err;
    }

    const captureUnit = capture.purchase_units?.[0]?.payments?.captures?.[0];
    if (!captureUnit || captureUnit.status !== "COMPLETED") {
      // PayPal answered and told us it did NOT complete — safe to mark failed.
      await this.paymentRepository.updateStatus(
        claimed.id,
        "failed",
        capture as unknown as Record<string, unknown>,
      );
      throw BadRequestError("Payment was not completed by PayPal.");
    }

    // ── 3. Short transaction to persist. ──────────────────────────────────────
    const result = await this.finalizeCapture(
      claimed.id,
      capture as unknown as Record<string, unknown>,
    );
    logger.info(
      { companyId, paypalOrderId, subscriptionEndsAt: result.subscriptionEndsAt },
      "Payment captured, company activated",
    );
    return result;
  }

  /**
   * Persist a confirmed capture and extend the subscription. Idempotent, locked, and
   * shared by both the synchronous capture path and the webhook so the two cannot
   * interleave and double-apply.
   */
  private async finalizeCapture(
    paymentId: string,
    paypalResponse: Record<string, unknown>,
  ): Promise<CapturePaymentResult> {
    return AppDataSource.transaction(async (manager) => {
      const payment = await this.paymentRepository.findByIdForUpdate(paymentId, manager);
      if (!payment) throw NotFoundError("Payment not found.");

      // Re-check under the lock — the other path may have finalized while we waited.
      if (payment.status === "captured") {
        return {
          paymentId: payment.id,
          kind: payment.kind === "spin_addon" ? "spin_addon" : "order",
          subscriptionStartsAt: payment.subscriptionStartsAt!,
          subscriptionEndsAt: payment.subscriptionEndsAt!,
        };
      }

      const now = new Date();
      const dates =
        payment.kind === "spin_addon"
          ? {
              subscriptionStartsAt: payment.subscriptionStartsAt!,
              subscriptionEndsAt: payment.subscriptionEndsAt!,
            }
          : await this.companyRepository.extendSubscription(
              {
                companyId: payment.company.id,
                planId: payment.plan.id,
                durationDays: payment.plan.durationDays,
                now,
              },
              manager,
            );
      const { subscriptionStartsAt, subscriptionEndsAt } = dates;

      await this.paymentRepository.updateCaptured(
        payment.id,
        {
          status: "captured",
          capturedAt: now,
          subscriptionStartsAt,
          subscriptionEndsAt,
          paypalResponse,
        },
        manager,
      );

      return {
        paymentId: payment.id,
        kind: payment.kind === "spin_addon" ? "spin_addon" : "order",
        subscriptionStartsAt,
        subscriptionEndsAt,
      };
    });
  }

  async handleWebhook(headers: Record<string, string>, rawBody: string): Promise<void> {
    const valid = await this.paypalService.verifyWebhookSignature({
      transmissionId: headers["paypal-transmission-id"] ?? "",
      transmissionTime: headers["paypal-transmission-time"] ?? "",
      certUrl: headers["paypal-cert-url"] ?? "",
      authAlgo: headers["paypal-auth-algo"] ?? "",
      transmissionSig: headers["paypal-transmission-sig"] ?? "",
      rawBody,
    });

    if (!valid) {
      logger.warn("PayPal webhook signature verification failed — ignoring event");
      return;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      logger.warn("PayPal webhook body is not valid JSON");
      return;
    }

    const eventType = event["event_type"] as string | undefined;

    // Everything that is not an Orders-era capture belongs to the Subscriptions
    // handler — the subscription lifecycle and recurring sale events. Routed here
    // rather than on a second endpoint because PayPal sends every event for the app to
    // one configured webhook URL.
    if (eventType !== "PAYMENT.CAPTURE.COMPLETED") {
      await this.paypalWebhookService.handle(event);
      return;
    }

    const resource = event["resource"] as Record<string, unknown> | undefined;
    // PayPal PAYMENT.CAPTURE.COMPLETED shape:
    // resource.supplementary_data.related_ids.order_id
    const relatedIds = (resource?.["supplementary_data"] as Record<string, unknown> | undefined)?.[
      "related_ids"
    ] as Record<string, unknown> | undefined;
    const orderId = relatedIds?.["order_id"] as string | undefined;

    if (!orderId || typeof orderId !== "string") {
      logger.warn({ event }, "PayPal webhook: could not extract order ID");
      return;
    }

    const payment = await this.paymentRepository.findByPaypalOrderId(orderId);
    if (!payment) {
      // THROW, don't return. PayPal is telling us it captured an order we have no
      // record of — capture and webhook disagree, and this is the exact case the
      // webhook exists to catch. Throwing makes the controller answer 5xx so PayPal
      // retries; returning here silently discarded the only signal we get.
      throw NotFoundError(`PayPal webhook: no payment record for order ${orderId}`);
    }

    if (payment.status === "captured") return; // idempotent

    // Same locked, atomic path the synchronous capture uses. Previously this did its
    // own unlocked read-compute-write, so a webhook arriving mid-capture could apply a
    // second subscription extension on top of the one being written.
    const result = await this.finalizeCapture(payment.id, event);

    logger.info(
      { orderId, companyId: payment.company.id, subscriptionEndsAt: result.subscriptionEndsAt },
      "PayPal webhook: company activated via webhook",
    );
  }

  private toDto(plan: Plan): PlanDto {
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      durationDays: plan.durationDays,
      price: plan.price,
      currency: plan.currency,
      isPopular: plan.isPopular,
      sortOrder: plan.sortOrder,
      isRecurring: plan.isRecurring === true && plan.paypalPlanId != null,
      drawSpins: 0,
    };
  }
}
