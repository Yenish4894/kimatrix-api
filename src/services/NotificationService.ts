import { AppDataSource } from "data-source";
import { EmailService } from "@/services/EmailService";
import { PaymentHistoryService } from "@/services/PaymentHistoryService";
import { buildPublicQrUrl } from "@/utils/qrUrl";
import { logger } from "@/utils/logger";
import type { RefundAccessChange } from "@/templates/refundProcessed.template";

interface OwnerRow {
  company_name: string;
  qr_token: string;
  deactivated_at: Date | null;
  email: string;
  user_active: boolean;
}

export interface RefundNotice {
  paymentId: string;
  companyId: string;
  extent: "full" | "partial";
  reversalId: string | null;
  amount: string | null;
  currency: string;
  access: RefundAccessChange;
}

/**
 * Turns a committed state change into a queued email for the company owner.
 *
 * Every method here is called AFTER the caller's transaction commits, and none of them
 * can throw: an email problem (Redis down, owner row gone) is logged and swallowed, so it
 * can never fail a payment, a webhook or a login. Callers `void` the returned promise
 * rather than awaiting it, because the Redis connection retries forever
 * (`maxRetriesPerRequest: null`): an awaited enqueue during a Redis outage would hang a
 * PayPal webhook until PayPal gave up on it.
 *
 * Log lines carry ids only, never an address.
 */
export class NotificationService {
  private emailService = new EmailService();
  private paymentHistoryService = new PaymentHistoryService();

  /** The QR poster, once, when the owner first proves their mailbox. */
  sendQrCode(companyId: string): Promise<void> {
    return this.safely("QR code", { companyId }, async () => {
      const owner = await this.owner(companyId);
      if (!owner || owner.deactivated_at != null) return;
      await this.emailService.enqueueQrCodeEmail({
        to: owner.email,
        companyId,
        companyName: owner.company_name,
        qrUrl: buildPublicQrUrl(owner.qr_token),
      });
    });
  }

  /** After a capture (order, spin add-on) or a credited renewal. */
  sendPaymentReceipt(p: { paymentId: string; companyId: string }): Promise<void> {
    return this.safely("payment receipt", p, async () => {
      const owner = await this.owner(p.companyId);
      if (!owner) return;
      await this.emailService.enqueuePaymentReceipt({
        to: owner.email,
        paymentId: p.paymentId,
        companyName: owner.company_name,
      });
    });
  }

  /**
   * A recurring renewal was declined.
   *
   * Only while the subscription is still failing. PayPal does not order its webhooks, so
   * a DENIED can arrive after the retry that succeeded; applyRemoteState has just read
   * PayPal's live state, and if that is healthy again this email would be false alarm.
   */
  sendRenewalFailed(paypalSubscriptionId: string): Promise<void> {
    return this.safely("renewal failed", { paypalSubscriptionId }, async () => {
      const rows = (await AppDataSource.query(
        `SELECT s."id" AS "subscription_id", s."status",
                c."name" AS "company_name", c."subscription_expires_at",
                u."email", u."is_active" AS "user_active"
           FROM "subscriptions" s
           JOIN "companies" c ON c."id" = s."company_id"
           JOIN "users" u ON u."id" = c."owner_user_id"
          WHERE s."paypal_subscription_id" = $1`,
        [paypalSubscriptionId],
      )) as {
        subscription_id: string;
        status: string;
        company_name: string;
        subscription_expires_at: Date | null;
        email: string;
        user_active: boolean;
      }[];
      const row = rows[0];
      if (!row || !row.user_active) return;
      if (row.status !== "past_due" && row.status !== "suspended") {
        logger.info(
          { paypalSubscriptionId, status: row.status },
          "Renewal-failed email skipped: the subscription is no longer failing",
        );
        return;
      }
      await this.emailService.enqueuePaymentFailed({
        to: row.email,
        subscriptionId: row.subscription_id,
        companyName: row.company_name,
        accessUntil: row.subscription_expires_at ? new Date(row.subscription_expires_at) : null,
      });
    });
  }

  /** After handleCaptureReversal commits a full or partial refund. */
  sendRefundProcessed(n: RefundNotice): Promise<void> {
    return this.safely("refund", { paymentId: n.paymentId, companyId: n.companyId }, async () => {
      const owner = await this.owner(n.companyId);
      if (!owner) return;
      // The invoice row is still readable after a refund (status 'refunded').
      const invoice = await this.paymentHistoryService.buildInvoiceDataById(n.paymentId);
      const access: RefundAccessChange =
        n.access.type === "access_reduced"
          ? { ...n.access, spinsRemoved: (invoice?.drawSpins ?? 0) > 0 }
          : n.access;
      await this.emailService.enqueueRefundProcessed({
        to: owner.email,
        paymentId: n.paymentId,
        extent: n.extent,
        reversalId: n.reversalId,
        companyName: owner.company_name,
        amount: n.amount,
        currency: n.currency,
        description: invoice?.description ?? "your payment",
        invoiceNumber: invoice?.invoiceNumber ?? null,
        access,
      });
    });
  }

  /** The owner's LOGIN email: that is the address that proved itself and gets billing mail. */
  private async owner(companyId: string): Promise<OwnerRow | null> {
    const rows = (await AppDataSource.query(
      `SELECT c."name" AS "company_name", c."qr_token", c."deactivated_at",
              u."email", u."is_active" AS "user_active"
         FROM "companies" c
         JOIN "users" u ON u."id" = c."owner_user_id"
        WHERE c."id" = $1`,
      [companyId],
    )) as OwnerRow[];
    const row = rows[0];
    return row && row.user_active ? row : null;
  }

  private async safely(
    label: string,
    context: Record<string, unknown>,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (err) {
      logger.error(
        { err, ...context },
        `Could not enqueue the ${label} email; the change it reports is committed and stands`,
      );
    }
  }
}
