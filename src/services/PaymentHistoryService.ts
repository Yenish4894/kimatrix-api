import { NotFoundError } from "@/errors/index";
import type { PaymentKind, PaymentStatus } from "@/entities/Payment";
import {
  PaymentRepository,
  type AdminPaymentFilters,
  type InvoicePaymentRow,
  type PaymentHistoryRow,
} from "@/repositories/PaymentRepository";
import {
  invoiceDescription,
  invoiceNumber,
  renderInvoicePdf,
  type InvoiceData,
} from "@/pdf/invoice";

export interface PaymentHistoryItem {
  id: string;
  /** Null only for admin rows that never captured (pending, failed...): no invoice exists. */
  invoiceNumber: string | null;
  kind: PaymentKind;
  description: string;
  planName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  amount: string;
  currency: string;
  status: PaymentStatus;
  paidAt: string | null;
  drawSpins: number;
  paypalReference: string | null;
}

export interface AdminPaymentHistoryItem extends PaymentHistoryItem {
  company: { id: string; name: string };
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isInvoiceable(status: PaymentStatus): boolean {
  return status === "captured" || status === "refunded";
}

/**
 * The invoice's date. A captured row always has captured_at; created_at is only a
 * fallback so a refunded row with a missing stamp can still be printed, instead of
 * failing on the one document the customer needs for a dispute.
 */
function issueDate(row: PaymentHistoryRow): Date {
  return new Date(row.captured_at ?? row.created_at);
}

export function toHistoryItem(row: PaymentHistoryRow): PaymentHistoryItem {
  const drawSpins = Number(row.draw_spins) || 0;
  return {
    id: row.id,
    invoiceNumber: isInvoiceable(row.status) ? invoiceNumber(row.id, issueDate(row)) : null,
    kind: row.kind,
    description: invoiceDescription({ kind: row.kind, planName: row.plan_name, drawSpins }),
    // A spin add-on's plan_id is incidental (the column is NOT NULL); don't present it
    // as something that was bought.
    planName: row.kind === "spin_addon" ? null : row.plan_name,
    periodStart: iso(row.subscription_starts_at),
    periodEnd: iso(row.subscription_ends_at),
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    paidAt: iso(row.captured_at),
    drawSpins,
    // A renewal has a sale id and no order id; every other kind has an order id.
    paypalReference: row.paypal_order_id ?? row.paypal_sale_id ?? null,
  };
}

export class PaymentHistoryService {
  private paymentRepository = new PaymentRepository();

  async listForCompany(
    companyId: string,
    page: number,
    limit: number,
  ): Promise<{ items: PaymentHistoryItem[]; total: number }> {
    const { items, total } = await this.paymentRepository.listHistoryForCompany(
      companyId,
      page,
      limit,
    );
    return { items: items.map(toHistoryItem), total };
  }

  async listForAdmin(
    filters: AdminPaymentFilters,
  ): Promise<{ items: AdminPaymentHistoryItem[]; total: number }> {
    const { items, total } = await this.paymentRepository.listHistoryForAdmin(filters);
    return {
      items: items.map((row) => ({
        ...toHistoryItem(row),
        company: { id: row.company_id, name: row.company_name },
      })),
      total,
    };
  }

  /** `companyId` null = admin (any company). Always 404 for someone else's payment. */
  async renderInvoice(
    paymentId: string,
    companyId: string | null,
  ): Promise<{ filename: string; body: Buffer }> {
    const row = await this.paymentRepository.findInvoiceRow(paymentId, companyId);
    if (!row) throw NotFoundError("Invoice not found");

    const data = toInvoiceData(row);
    return { filename: invoiceFilename(data.invoiceNumber), body: renderInvoicePdf(data) };
  }

  /**
   * INTERNAL USE ONLY: no ownership check. For the email worker and NotificationService,
   * which act on a payment id they got from their own committed transaction. Never call
   * this with an id from a request; the routes use renderInvoice, which scopes by company.
   *
   * Null when the payment is not invoiceable (not captured/refunded, or deleted).
   */
  async buildInvoiceDataById(paymentId: string): Promise<InvoiceData | null> {
    const row = await this.paymentRepository.findInvoiceRow(paymentId, null);
    return row ? toInvoiceData(row) : null;
  }
}

export function invoiceFilename(number: string): string {
  return `kimates-invoice-${number}.pdf`;
}

/** The one mapping from a payment row to a printable invoice, shared by download and email. */
function toInvoiceData(row: InvoicePaymentRow): InvoiceData {
  const item = toHistoryItem(row);
  const number = item.invoiceNumber ?? invoiceNumber(row.id, issueDate(row));
  return {
    invoiceNumber: number,
    issuedAt: issueDate(row),
    status: row.status === "refunded" ? "refunded" : "captured",
    kind: row.kind,
    description: item.description,
    periodStart: row.subscription_starts_at ? new Date(row.subscription_starts_at) : null,
    periodEnd: row.subscription_ends_at ? new Date(row.subscription_ends_at) : null,
    drawSpins: item.drawSpins,
    amount: row.amount,
    currency: row.currency,
    paypalReference: item.paypalReference,
    billTo: {
      name: row.company_name,
      registrationNumber: row.registration_number,
      streetAddress: row.street_address,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
      country: row.country,
      contactEmail: row.contact_email,
    },
  };
}
