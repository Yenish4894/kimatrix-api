import type { SubscriptionStatus } from "@/entities/Company";

/**
 * The single source of truth for "what is this company allowed to do right now".
 *
 * Pure and DB-free on purpose. Every access gate (companyMiddleware,
 * requireActiveSubscription, QrService) calls this in real time rather than
 * reading `companies.subscription_status`, so a stalled cron, a clock skew, or a
 * missed webhook can never revoke access from a customer who has actually paid.
 *
 * `subscription_status` is only a materialized projection of `status` below,
 * maintained by the expiry cron for indexed queries and UI badges.
 */

/** The subset of Company this function reads. Keeps it testable without an entity. */
export interface EntitlementInput {
  isActive: boolean;
  deactivatedAt: Date | null;
  subscriptionExpiresAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  isComped: boolean;
  compedUntil: Date | null;
}

export interface Entitlement {
  status: SubscriptionStatus;
  /** Dashboard data routes AND acceptance of public QR submissions. */
  hasAccess: boolean;
  isTrial: boolean;
  /** When access lapses. `null` = never (perpetual comp) or never started. */
  endsAt: Date | null;
  /** Data export survives expiry — it's the "download and leave" path. */
  canExport: boolean;
}

function isFuture(date: Date | null, now: Date): boolean {
  return date != null && date.getTime() > now.getTime();
}

export function computeEntitlement(company: EntitlementInput, now: Date): Entitlement {
  // 1. Admin kill switch. The only state that also blocks export.
  if (!company.isActive && company.deactivatedAt != null) {
    return {
      status: "deactivated",
      hasAccess: false,
      isTrial: false,
      endsAt: null,
      canExport: false,
    };
  }

  // 2. Admin comp — the explicit free override. `compedUntil === null` is perpetual.
  if (company.isComped && (company.compedUntil === null || isFuture(company.compedUntil, now))) {
    return {
      status: "active",
      hasAccess: true,
      isTrial: false,
      endsAt: company.compedUntil,
      canExport: true,
    };
  }

  // 3. Live paid subscription.
  if (isFuture(company.subscriptionExpiresAt, now)) {
    return {
      status: "active",
      hasAccess: true,
      isTrial: false,
      endsAt: company.subscriptionExpiresAt,
      canExport: true,
    };
  }

  // 4. Live trial. Checked after paid so converting mid-trial can never downgrade.
  if (isFuture(company.trialEndsAt, now)) {
    return {
      status: "trialing",
      hasAccess: true,
      isTrial: true,
      endsAt: company.trialEndsAt,
      canExport: true,
    };
  }

  // 5. Paid, but lapsed. Takes precedence over an expired trial: once someone has
  //    paid, they're a lapsed customer, not a lapsed trialist.
  if (company.subscriptionExpiresAt != null) {
    return {
      status: "expired",
      hasAccess: false,
      isTrial: false,
      endsAt: company.subscriptionExpiresAt,
      canExport: true,
    };
  }

  // 6. Trialed, never paid, trial is over.
  if (company.trialEndsAt != null) {
    return {
      status: "trial_expired",
      hasAccess: false,
      isTrial: false,
      endsAt: company.trialEndsAt,
      canExport: true,
    };
  }

  // 7. Registered, no trial granted, never paid.
  return {
    status: "pending",
    hasAccess: false,
    isTrial: false,
    endsAt: null,
    canExport: true,
  };
}
