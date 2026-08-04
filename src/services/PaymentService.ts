import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { logger } from "@/utils/logger";
import { PlanRepository } from "@/repositories/PlanRepository";
import { PaymentRepository } from "@/repositories/PaymentRepository";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { PaypalService } from "@/services/PaypalService";
import { BadRequestError, ConflictError, NotFoundError } from "@/errors/index";
import type { Plan } from "@/entities/Plan";

export interface PlanDto {
  id: string;
  name: string;
  description: string | null;
  durationDays: number;
  price: string;
  currency: string;
  /** Drives the "Most Popular" badge. Replaces the frontend's hardcoded 30-day check. */
  isPopular: boolean;
  sortOrder: number;
}

export interface InitiatePaymentResult {
  paymentId: string;
  paypalOrderId: string;
  approvalUrl: string;
}

export interface CapturePaymentResult {
  paymentId: string;
  subscriptionStartsAt: Date;
  subscriptionEndsAt: Date;
}

export class PaymentService {
  private planRepository = new PlanRepository();
  private paymentRepository = new PaymentRepository();
  private companyRepository = new CompanyRepository();
  private paypalService = new PaypalService();

  async getPlans(): Promise<PlanDto[]> {
    const plans = await this.planRepository.findAllActive();
    return plans.map(this.toDto);
  }

  async initiatePayment(companyId: string, planId: string): Promise<InitiatePaymentResult> {
    const plan = await this.planRepository.findById(planId);
    if (!plan) throw NotFoundError("Plan not found.");

    const returnUrl = `${config.FRONTEND_BASE_URL}/company/billing/success`;
    const cancelUrl = `${config.FRONTEND_BASE_URL}/company/billing/cancel`;

    const order = await this.paypalService.createOrder({
      amount: Number(plan.price),
      currency: plan.currency,
      referenceId: `${companyId}:${planId}`,
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
      amount: Number(plan.price),
      currency: plan.currency,
    });

    logger.info({ companyId, planId, paypalOrderId: order.id }, "PayPal order created");

    return {
      paymentId: payment.id,
      paypalOrderId: order.id,
      approvalUrl: approvalLink.href,
    };
  }

  async capturePayment(companyId: string, paypalOrderId: string): Promise<CapturePaymentResult> {
    // Quick non-locking check — avoids acquiring a row lock for already-completed payments
    const existing = await this.paymentRepository.findByPaypalOrderId(paypalOrderId);
    if (existing?.status === "captured") {
      return {
        paymentId: existing.id,
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
          subscriptionStartsAt: current.subscriptionStartsAt!,
          subscriptionEndsAt: current.subscriptionEndsAt!,
        };
      }
      if (current.status === "capturing") {
        throw ConflictError("This payment is already being processed. Please wait a moment.");
      }
      throw BadRequestError("This payment cannot be captured.");
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
          subscriptionStartsAt: payment.subscriptionStartsAt!,
          subscriptionEndsAt: payment.subscriptionEndsAt!,
        };
      }

      const now = new Date();
      const { subscriptionStartsAt, subscriptionEndsAt } =
        await this.companyRepository.extendSubscription(
          {
            companyId: payment.company.id,
            planId: payment.plan.id,
            durationDays: payment.plan.durationDays,
            now,
          },
          manager,
        );

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

      return { paymentId: payment.id, subscriptionStartsAt, subscriptionEndsAt };
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
    if (eventType !== "PAYMENT.CAPTURE.COMPLETED") return;

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

  private computeSubscriptionDates(
    plan: Plan,
    currentExpiresAt: Date | null,
    now: Date,
  ): { subscriptionStartsAt: Date; subscriptionEndsAt: Date } {
    // If the company still has time left, stack the new plan on top of the current expiry
    const base = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
    const subscriptionStartsAt = base;
    const subscriptionEndsAt = new Date(base.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    return { subscriptionStartsAt, subscriptionEndsAt };
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
    };
  }
}
