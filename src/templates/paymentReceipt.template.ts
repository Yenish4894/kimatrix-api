import type { PaymentKind } from "@/entities/Payment";
import {
  brandName,
  formatEmailDate,
  formatMoney,
  renderBrandedEmail,
  type RenderedEmail,
} from "@/templates/layout";

export interface PaymentReceiptEmailData {
  companyName: string;
  invoiceNumber: string;
  kind: PaymentKind;
  /** The invoice line: plan name, "+ N spins", or "N lucky draw spins". */
  description: string;
  amount: string;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date;
  billingUrl: string;
}

function whatHappened(d: PaymentReceiptEmailData): string {
  const end = d.periodEnd ? formatEmailDate(d.periodEnd) : null;
  switch (d.kind) {
    case "subscription_cycle":
      return end
        ? `This was your automatic plan renewal. Your plan now runs until ${end}.`
        : "This was your automatic plan renewal.";
    case "spin_addon":
      return "Your spins have been added to the lucky draw for your current plan period.";
    default:
      return end ? `Your plan now runs until ${end}.` : "Your plan is active.";
  }
}

export function renderPaymentReceiptEmail(d: PaymentReceiptEmailData): RenderedEmail {
  const brand = brandName();
  const period =
    d.periodStart && d.periodEnd
      ? `${formatEmailDate(d.periodStart)} – ${formatEmailDate(d.periodEnd)}`
      : null;

  return renderBrandedEmail({
    subject: `Payment received — ${brand}`,
    heading: "Payment received",
    paragraphs: [
      `Thank you. We've received your payment for ${d.companyName}.`,
      whatHappened(d),
      "Your invoice is attached to this email as a PDF, and you can download it again at any time from your billing page.",
    ],
    details: [
      ["Invoice", d.invoiceNumber],
      ["Paid for", d.description],
      ...(period
        ? [[d.kind === "spin_addon" ? "Draw period" : "Period", period] as [string, string]]
        : []),
      ["Amount", formatMoney(d.amount, d.currency)],
      ["Paid on", formatEmailDate(d.paidAt)],
    ],
    cta: { label: "View billing", url: d.billingUrl },
    companyName: d.companyName,
  });
}
