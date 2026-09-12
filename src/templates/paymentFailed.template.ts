import {
  brandName,
  formatEmailDate,
  renderBrandedEmail,
  type RenderedEmail,
} from "@/templates/layout";

export interface PaymentFailedEmailData {
  companyName: string;
  /** companies.subscription_expires_at: what the customer has already paid for. */
  accessUntil: Date | null;
  billingUrl: string;
  now?: Date;
}

/**
 * A recurring renewal was declined. Written to reassure first and ask second: renewals are
 * charged a day early and PayPal retries, so nothing has been lost yet and access is
 * untouched. Revoking or threatening here would be wrong: see PaypalWebhookService.
 */
export function renderPaymentFailedEmail(d: PaymentFailedEmailData): RenderedEmail {
  const brand = brandName();
  const now = d.now ?? new Date();
  const until =
    d.accessUntil && d.accessUntil.getTime() > now.getTime()
      ? `Your access continues as normal until ${formatEmailDate(d.accessUntil)}.`
      : "Your access continues until the end of your current paid period.";

  return renderBrandedEmail({
    subject: `Your ${brand} renewal payment didn't go through`,
    heading: "We couldn't collect your renewal payment",
    paragraphs: [
      `PayPal was unable to take the automatic renewal payment for ${d.companyName}.`,
      "PayPal will retry the payment automatically over the next few days, so if the problem was temporary there is nothing you need to do. If your card has expired or your PayPal funding source has changed, update it in PayPal before the next attempt.",
      `${until} If the payment still hasn't gone through by then, your QR code will stop accepting new submissions until your plan is renewed.`,
    ],
    cta: { label: "Go to billing", url: d.billingUrl },
    companyName: d.companyName,
  });
}
