import {
  brandName,
  formatEmailDate,
  formatMoney,
  renderBrandedEmail,
  type RenderedEmail,
} from "@/templates/layout";

/** How the refund changed what the company has. Mirrors handleCaptureReversal exactly. */
export type RefundAccessChange =
  /** A plan order refunded in full: its window was subtracted from the expiry. */
  | { type: "access_reduced"; newEndsAt: string | null; spinsRemoved: boolean }
  /** A spin add-on refunded in full: the spins left the draw, access is untouched. */
  | { type: "spins_removed" }
  /** A partial refund: recorded for manual review, nothing taken away. */
  | { type: "none" };

export interface RefundProcessedEmailData {
  companyName: string;
  extent: "full" | "partial";
  /** Null when PayPal sent no usable figure for a partial refund. */
  amount: string | null;
  currency: string;
  description: string;
  invoiceNumber: string | null;
  access: RefundAccessChange;
  billingUrl: string;
  now?: Date;
}

function accessLines(access: RefundAccessChange, now: Date): string[] {
  switch (access.type) {
    case "access_reduced": {
      const end = access.newEndsAt ? new Date(access.newEndsAt) : null;
      const first = !end
        ? "The plan time this payment added has been removed from your account."
        : end.getTime() > now.getTime()
          ? `The plan time this payment added has been removed. Your access now ends on ${formatEmailDate(end)}.`
          : `The plan time this payment added has been removed, so your paid access ended on ${formatEmailDate(end)}. Your QR code will not accept new submissions until you choose a plan.`;
      return access.spinsRemoved
        ? [first, "The lucky draw spins bought with it have been removed as well."]
        : [first];
    }
    case "spins_removed":
      return [
        "Your spins from this purchase were removed from the lucky draw. Your plan and its end date are unchanged.",
      ];
    case "none":
      return [
        "No change to your access: your plan, its end date and your lucky draw spins stay exactly as they are.",
      ];
  }
}

export function renderRefundProcessedEmail(d: RefundProcessedEmailData): RenderedEmail {
  const brand = brandName();
  const full = d.extent === "full";
  const money = d.amount ? formatMoney(d.amount, d.currency) : null;
  const what = money
    ? `A ${full ? "full" : "partial"} refund of ${money} has been issued for ${d.description} on the ${d.companyName} account.`
    : `A ${full ? "full" : "partial"} refund has been issued for ${d.description} on the ${d.companyName} account.`;

  return renderBrandedEmail({
    subject: full ? `Refund processed — ${brand}` : `Partial refund processed — ${brand}`,
    heading: full ? "Your refund has been processed" : "Your partial refund has been processed",
    paragraphs: [
      what,
      ...accessLines(d.access, d.now ?? new Date()),
      "PayPal returns the money to the original payment method. It can take a few days to appear.",
    ],
    details: [
      ...(d.invoiceNumber ? [["Invoice", d.invoiceNumber] as [string, string]] : []),
      ["Refunded", money ?? "See PayPal for the amount"],
    ],
    cta: { label: "View billing", url: d.billingUrl },
    companyName: d.companyName,
  });
}
