import { ConflictError, TooManyRequestsError, type AppError } from "@/middleware/errorHandler";

export const INVOICE_ALREADY_SUBMITTED = "This invoice number has already been submitted";

const RECENTLY_SUBMITTED =
  "You've already submitted a receipt at this business recently. Please wait a few minutes before submitting another one.";

/**
 * Advisory-lock keys that serialise QR submissions which could collide.
 *
 * Two submissions with the same mobile, or the same invoice number, at the same company
 * must not run side by side: each would pass the cooldown and duplicate-invoice checks
 * before the other committed, and the loser then hit a unique index and got the
 * errorHandler's generic "Some of your details are already in use" 409. Holding these
 * for the transaction makes the second one wait, then see the first and get the
 * specific answer.
 *
 * Always taken in this order (mobile, then invoice), and the namespaces differ, so two
 * submissions can never each hold the lock the other wants.
 */
export function submissionLockKeys(
  companyId: string,
  mobile: string,
  invoiceNumber: string,
): [string, string][] {
  return [
    [`qr-mobile:${companyId}`, mobile],
    [`qr-invoice:${companyId}`, invoiceNumber],
  ];
}

/** The constraint a Postgres unique violation names, from a raw or TypeORM-wrapped error. */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = e.code ?? e.driverError?.code;
  const constraint = e.constraint ?? e.driverError?.constraint;
  return code === "23505" && typeof constraint === "string" ? constraint : null;
}

/**
 * The specific answer for a unique violation raised by a QR submission, or null for any
 * other error. Backstop to the locks above: the indexes remain the final word.
 */
export function qrSubmitConflict(err: unknown): AppError | null {
  switch (uniqueViolationConstraint(err)) {
    case "uq_purchases_company_invoice":
      return ConflictError(INVOICE_ALREADY_SUBMITTED);
    case "uq_customers_shop_mobile":
    case "uq_customers_fuel_mobile_vehicle":
      return TooManyRequestsError(RECENTLY_SUBMITTED);
    default:
      return null;
  }
}
