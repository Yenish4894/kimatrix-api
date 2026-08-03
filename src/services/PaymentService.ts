import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { logger } from "@/utils/logger";
import { PlanRepository } from "@/repositories/PlanRepository";
import { PaymentRepository } from "@/repositories/PaymentRepository";
import { PaypalService } from "@/services/PaypalService";
import { BadRequestError, NotFoundError } from "@/errors/index";
import type { Plan } from "@/entities/Plan";
import { Company } from "@/entities/Company";

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

    return AppDataSource.transaction(async (manager) => {
      // Pessimistic write lock — prevents concurrent requests from both calling PayPal capture
      const payment = await this.paymentRepository.findByPaypalOrderIdForUpdate(
        paypalOrderId,
        manager,
      );

      if (!payment) throw NotFoundError("Payment not found.");
      if (payment.company.id !== companyId) throw NotFoundError("Payment not found.");

      // Re-check inside the lock (another request may have captured while we waited)
      if (payment.status === "captured") {
        return {
          paymentId: payment.id,
          subscriptionStartsAt: payment.subscriptionStartsAt!,
          subscriptionEndsAt: payment.subscriptionEndsAt!,
        };
      }
      if (payment.status !== "pending") {
        throw BadRequestError("This payment cannot be captured.");
      }

      const capture = await this.paypalService.captureOrder(paypalOrderId);

      const captureUnit = capture.purchase_units?.[0]?.payments?.captures?.[0];
      if (!captureUnit || captureUnit.status !== "COMPLETED") {
        await this.paymentRepository.updateStatus(
          payment.id,
          "failed",
          capture as unknown as Record<string, unknown>,
          manager,
        );
        throw BadRequestError("Payment was not completed by PayPal.");
      }

      const now = new Date();
      const { subscriptionStartsAt, subscriptionEndsAt } = this.computeSubscriptionDates(
        payment.plan,
        payment.company.subscriptionExpiresAt,
        now,
      );

      await this.paymentRepository.updateCaptured(
        payment.id,
        {
          status: "captured",
          capturedAt: now,
          subscriptionStartsAt,
          subscriptionEndsAt,
          paypalResponse: capture as unknown as Record<string, unknown>,
        },
        manager,
      );

      await manager.getRepository(Company).update(companyId, {
        isActive: true,
        currentPlan: { id: payment.plan.id } as never,
        subscriptionExpiresAt: subscriptionEndsAt,
        deactivatedAt: null,
        deactivatedBy: null,
      });

      logger.info(
        { companyId, paypalOrderId, subscriptionEndsAt },
        "Payment captured, company activated",
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
      logger.warn({ orderId }, "PayPal webhook: payment record not found");
      return;
    }

    if (payment.status === "captured") return; // idempotent

    const now = new Date();
    const { subscriptionStartsAt, subscriptionEndsAt } = this.computeSubscriptionDates(
      payment.plan,
      payment.company.subscriptionExpiresAt,
      now,
    );

    await AppDataSource.transaction(async (manager) => {
      await this.paymentRepository.updateCaptured(
        payment.id,
        {
          status: "captured",
          capturedAt: now,
          subscriptionStartsAt,
          subscriptionEndsAt,
          paypalResponse: event,
        },
        manager,
      );

      await manager.getRepository(Company).update(payment.company.id, {
        isActive: true,
        currentPlan: { id: payment.plan.id } as never,
        subscriptionExpiresAt: subscriptionEndsAt,
        deactivatedAt: null,
        deactivatedBy: null,
      });
    });

    logger.info(
      { orderId, companyId: payment.company.id, subscriptionEndsAt },
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
