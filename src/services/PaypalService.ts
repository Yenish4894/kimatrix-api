import { config } from "@/config/index";
import { logger } from "@/utils/logger";
import { fetchWithTimeout as fetchWithDeadline } from "@/utils/fetchWithTimeout";
import { AppError, BadRequestError } from "@/errors/index";
import type { PaypalOrderView } from "@/utils/paymentReconcile";

interface PaypalTokenResponse {
  access_token: string;
  expires_in: number;
}

interface PaypalErrorBody {
  name?: string;
  message?: string;
  details?: { issue?: string; description?: string }[];
}

const PAYMENT_PROVIDER_ERROR = "PAYMENT_PROVIDER_ERROR";

// Buyer-actionable capture issues → surface a clear, friendly 400 so the user
// knows what to do. Anything else is treated as an upstream provider failure (502),
// never a generic 500.
const CAPTURE_ISSUE_MESSAGES: Record<string, string> = {
  INSTRUMENT_DECLINED: "Your payment method was declined by PayPal. Please try a different one.",
  PAYER_CANNOT_PAY:
    "This PayPal account can't complete the payment. Please use a different method.",
  PAYER_ACCOUNT_RESTRICTED: "Your PayPal account is restricted and can't complete this payment.",
  TRANSACTION_REFUSED:
    "PayPal refused the transaction. Please try again or use a different method.",
  ORDER_NOT_APPROVED:
    "This payment hasn't been approved on PayPal yet. Please complete the PayPal approval and try again.",
  ORDER_ALREADY_CAPTURED: "This payment has already been completed.",
};

/**
 * Capture answers that mean PayPal refused and no money moved, so the buyer can safely
 * go back to PayPal and retry. ORDER_ALREADY_CAPTURED is deliberately NOT here: money
 * did move, and the webhook or reconcile job must finalize that row.
 */
const NO_FUNDS_MOVED_ISSUES = new Set([
  "INSTRUMENT_DECLINED",
  "PAYER_CANNOT_PAY",
  "PAYER_ACCOUNT_RESTRICTED",
  "TRANSACTION_REFUSED",
  "ORDER_NOT_APPROVED",
]);

/** PayPal definitively refused a capture; nothing was charged. */
export class PaypalDeclinedError extends AppError {
  constructor(
    message: string,
    public readonly issue: string,
  ) {
    super(message, 400, "BAD_REQUEST");
  }
}

async function parsePaypalError(
  res: Response,
): Promise<{ name: string | undefined; issue: string | undefined; raw: string }> {
  const raw = await res.text();
  try {
    const body = JSON.parse(raw) as PaypalErrorBody;
    return { name: body.name, issue: body.details?.[0]?.issue, raw };
  } catch {
    return { name: undefined, issue: undefined, raw };
  }
}

/** `invalid_client: Client Authentication failed` from an OAuth error body, or nothing. */
function tokenErrorSummary(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: unknown; error_description?: unknown };
    const parts = [body.error, body.error_description].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return parts.join(": ").slice(0, 200);
  } catch {
    return "";
  }
}

export interface PaypalOrderResult {
  id: string;
  status: string;
  links: { href: string; rel: string; method: string }[];
}

export interface PaypalCaptureResult {
  id: string;
  status: string;
  purchase_units: {
    payments: {
      captures: {
        id: string;
        status: string;
        amount: { currency_code: string; value: string };
      }[];
    };
  }[];
}

const PAYPAL_TIMEOUT_MS = 15_000;

/** PayPal's deadline, over the shared helper (also used by the Turnstile check). */
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetchWithDeadline(url, init, PAYPAL_TIMEOUT_MS);
}

export interface PaypalSubscriptionResource {
  id: string;
  status: string;
  plan_id?: string;
  custom_id?: string;
  start_time?: string;
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { time?: string; amount?: { value: string; currency_code: string } };
    /** Non-zero means PayPal is retrying a failed payment — our `past_due`. */
    failed_payments_count?: number;
  };
}

export class PaypalService {
  private baseUrl: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private lastTokenError: string | null = null;

  constructor() {
    this.baseUrl =
      config.PAYPAL_MODE === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com";
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const credentials = Buffer.from(
      `${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`,
    ).toString("base64");

    const res = await fetchWithTimeout(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error({ status: res.status, body: raw }, "PayPal token fetch failed");
      // Kept for verifyCredentials. OAuth errors are `{ error, error_description }`,
      // which name the problem ("invalid_client") without echoing any credential.
      this.lastTokenError = `${res.status} ${tokenErrorSummary(raw)}`.trim();
      throw new AppError(
        "The payment service is temporarily unavailable. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }

    const data = (await res.json()) as PaypalTokenResponse;
    this.cachedToken = data.access_token;
    // subtract 60s buffer so we refresh before expiry
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.cachedToken;
  }

  /**
   * Health check for the admin system-status page: can we obtain a token right now?
   *
   * Goes through `getAccessToken`, so it exercises exactly the path real payments use.
   * Callers wanting a live answer should use a fresh instance (empty token cache).
   * Returns rather than throws, with PayPal's status and error code for the detail
   * line — `getAccessToken` deliberately throws only a customer-safe message.
   */
  async verifyCredentials(): Promise<{ ok: true } | { ok: false; detail: string }> {
    try {
      await this.getAccessToken();
      return { ok: true };
    } catch (err) {
      const detail =
        err instanceof AppError
          ? (this.lastTokenError ?? err.message)
          : err instanceof Error
            ? err.name === "AbortError"
              ? "ETIMEDOUT: PayPal did not respond"
              : err.message
            : String(err);
      return { ok: false, detail };
    }
  }

  async createOrder(opts: {
    amount: number;
    currency: string;
    referenceId: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<PaypalOrderResult> {
    const token = await this.getAccessToken();

    const res = await fetchWithTimeout(`${this.baseUrl}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: opts.referenceId,
            amount: {
              currency_code: opts.currency,
              value: opts.amount.toFixed(2),
            },
          },
        ],
        application_context: {
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl,
          brand_name: "KIMates",
          landing_page: "BILLING",
          user_action: "PAY_NOW",
        },
      }),
    });

    if (!res.ok) {
      const { name, issue, raw } = await parsePaypalError(res);
      logger.error({ status: res.status, name, issue, body: raw }, "PayPal create-order failed");
      if (issue === "CURRENCY_NOT_SUPPORTED") {
        throw BadRequestError(
          "This plan's currency is not supported by PayPal. Please contact support.",
        );
      }
      throw new AppError(
        "Payment could not be initiated right now. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }

    return (await res.json()) as PaypalOrderResult;
  }

  async captureOrder(orderId: string): Promise<PaypalCaptureResult> {
    const token = await this.getAccessToken();

    const res = await fetchWithTimeout(`${this.baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const { name, issue, raw } = await parsePaypalError(res);
      logger.error(
        { status: res.status, name, issue, body: raw, orderId },
        "PayPal capture failed",
      );
      const friendly = issue ? CAPTURE_ISSUE_MESSAGES[issue] : undefined;
      if (friendly && issue && NO_FUNDS_MOVED_ISSUES.has(issue)) {
        throw new PaypalDeclinedError(friendly, issue);
      }
      if (friendly) throw BadRequestError(friendly);
      throw new AppError(
        "We couldn't complete your PayPal payment. Please try again.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }

    return (await res.json()) as PaypalCaptureResult;
  }

  /**
   * PayPal's current view of an order, for reconciling a payment whose capture we never
   * heard back from. A 404 returns null (PayPal has no such order — retrying will not
   * change that); anything else that fails throws, and the caller tries again later.
   */
  async getOrder(orderId: string): Promise<PaypalOrderView | null> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const { name, issue, raw } = await parsePaypalError(res);
      logger.error(
        { status: res.status, name, issue, body: raw, orderId },
        "PayPal get-order failed",
      );
      throw new AppError(
        "The payment service is temporarily unavailable. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    return (await res.json()) as PaypalOrderView;
  }

  async verifyWebhookSignature(opts: {
    transmissionId: string;
    transmissionTime: string;
    certUrl: string;
    authAlgo: string;
    transmissionSig: string;
    rawBody: string;
  }): Promise<"valid" | "invalid"> {
    // "invalid" is reserved for PayPal's own FAILURE verdict — a forged or tampered
    // event, which is safe to acknowledge and drop. Everything that merely stops us
    // reaching a verdict (no webhook id, PayPal's verify API down or rate-limiting us)
    // THROWS: the controller then answers 5xx and PayPal retries. Returning false for
    // those used to answer 200, and PayPal never resent the event.
    if (!config.PAYPAL_WEBHOOK_ID) {
      throw new Error("PAYPAL_WEBHOOK_ID is not set — cannot verify PayPal webhooks");
    }

    // PayPal always sends all five transmission headers and a JSON body. A request
    // without them is not from PayPal: drop it here, without a PayPal call, and without
    // the 5xx + error log a throw would cost for every junk request.
    const headers = [
      opts.transmissionId,
      opts.transmissionTime,
      opts.certUrl,
      opts.authAlgo,
      opts.transmissionSig,
    ];
    if (headers.some((h) => !h)) return "invalid";
    let webhookEvent: unknown;
    try {
      webhookEvent = JSON.parse(opts.rawBody);
    } catch {
      return "invalid";
    }

    const token = await this.getAccessToken();

    const res = await fetchWithTimeout(
      `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transmission_id: opts.transmissionId,
          transmission_time: opts.transmissionTime,
          cert_url: opts.certUrl,
          auth_algo: opts.authAlgo,
          transmission_sig: opts.transmissionSig,
          webhook_id: config.PAYPAL_WEBHOOK_ID,
          webhook_event: webhookEvent,
        }),
      },
    );

    // 400/422: PayPal rejected the headers themselves as malformed — forged, and no
    // retry will change that. Anything else (401 token, 429, 5xx) is on our side or
    // PayPal's, so throw and let PayPal retry.
    if (res.status === 400 || res.status === 422) return "invalid";
    if (!res.ok) {
      throw new Error(`PayPal verify-webhook-signature failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as { verification_status: string };
    return data.verification_status === "SUCCESS" ? "valid" : "invalid";
  }

  // ─── Subscriptions API ────────────────────────────────────────────────────

  /**
   * Creates (or reuses) the single catalog product every billing plan hangs off.
   *
   * `PayPal-Request-Id` makes this idempotent at PayPal's end, so a retry after a
   * timeout returns the original product rather than creating a second one. Without it
   * a flaky network during setup quietly leaves duplicate products behind.
   */
  async ensureProduct(requestId: string, name: string): Promise<string> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(`${this.baseUrl}/v1/catalogs/products`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
      body: JSON.stringify({ name, type: "SERVICE", category: "SOFTWARE" }),
    });
    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error({ status: res.status, body: raw }, "PayPal product creation failed");
      throw new AppError(
        "The payment service is temporarily unavailable. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /**
   * Creates a recurring billing plan.
   *
   * `total_cycles: 0` means "bill forever" — a finite count would silently stop
   * charging after N periods and the customer would lose access with no explanation.
   *
   * **No TRIAL tenure, deliberately.** A native PayPal trial requires the buyer to bind
   * a funding source before it starts, which is the opposite of "walk away without ever
   * paying", and our trial is already granted and tracked in our own database. Adding
   * one here would also hand a converting customer their free days twice.
   */
  async createBillingPlan(opts: {
    requestId: string;
    productId: string;
    name: string;
    description?: string;
    intervalUnit: "DAY" | "WEEK" | "MONTH" | "YEAR";
    intervalCount: number;
    price: string;
    currency: string;
  }): Promise<{ id: string; status: string }> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(`${this.baseUrl}/v1/billing/plans`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": opts.requestId,
      },
      body: JSON.stringify({
        product_id: opts.productId,
        name: opts.name,
        ...(opts.description ? { description: opts.description } : {}),
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: {
              interval_unit: opts.intervalUnit,
              interval_count: opts.intervalCount,
            },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value: opts.price, currency_code: opts.currency },
            },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true },
      }),
    });
    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error({ status: res.status, body: raw }, "PayPal billing plan creation failed");
      throw new AppError(
        "That plan could not be set up with the payment provider.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    const data = (await res.json()) as { id: string; status: string };
    return data;
  }

  /**
   * Starts a subscription and returns the URL the buyer must approve at.
   *
   * `startTime` is how a customer converting from a trial or from leftover Orders-era
   * time avoids being charged twice: billing begins when their existing access ends,
   * not immediately. PayPal rejects a start time in the past, so the caller must clamp
   * it — see SubscriptionService.
   */
  async createSubscription(opts: {
    requestId: string;
    paypalPlanId: string;
    returnUrl: string;
    cancelUrl: string;
    startTime?: Date;
    customId: string;
  }): Promise<{ id: string; status: string; approvalUrl: string }> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(`${this.baseUrl}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": opts.requestId,
      },
      body: JSON.stringify({
        plan_id: opts.paypalPlanId,
        ...(opts.startTime ? { start_time: opts.startTime.toISOString() } : {}),
        // Echoed back on every webhook — the link from a PayPal event to our company.
        custom_id: opts.customId,
        application_context: {
          brand_name: "KIMates",
          user_action: "SUBSCRIBE_NOW",
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl,
          shipping_preference: "NO_SHIPPING",
        },
      }),
    });
    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error({ status: res.status, body: raw }, "PayPal subscription creation failed");
      throw new AppError(
        "We couldn't start that subscription. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    const data = (await res.json()) as {
      id: string;
      status: string;
      links?: { rel: string; href: string }[];
    };
    const approvalUrl = data.links?.find((l) => l.rel === "approve")?.href;
    if (!approvalUrl) {
      logger.error({ subscriptionId: data.id }, "PayPal returned no approval link");
      throw new AppError(
        "We couldn't start that subscription. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    return { id: data.id, status: data.status, approvalUrl };
  }

  /**
   * Completed sales on a subscription in a time window, for reconciliation. The ids are
   * the same sale ids PAYMENT.SALE.COMPLETED delivers, so crediting them goes through
   * creditCycle's unique-sale-id guard and a sale already credited is a no-op.
   */
  async listSubscriptionSales(
    subscriptionId: string,
    from: Date,
    to: Date,
  ): Promise<{ saleId: string; amount: string; currency: string }[]> {
    const token = await this.getAccessToken();
    const qs = `start_time=${encodeURIComponent(from.toISOString())}&end_time=${encodeURIComponent(to.toISOString())}`;
    const res = await fetchWithTimeout(
      `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions?${qs}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error(
        { status: res.status, body: raw, subscriptionId },
        "PayPal transactions fetch failed",
      );
      throw new AppError("PayPal transactions unavailable", 502, PAYMENT_PROVIDER_ERROR);
    }
    const data = (await res.json()) as {
      transactions?: {
        id?: string;
        status?: string;
        amount_with_breakdown?: { gross_amount?: { value?: string; currency_code?: string } };
      }[];
    };
    return (data.transactions ?? [])
      .filter((t) => t.status === "COMPLETED" && typeof t.id === "string")
      .map((t) => ({
        saleId: t.id!,
        amount: t.amount_with_breakdown?.gross_amount?.value ?? "",
        currency: t.amount_with_breakdown?.gross_amount?.currency_code ?? "",
      }));
  }

  /**
   * The authoritative state. Always read this back rather than trusting a webhook body.
   *
   * A 404 returns `null` instead of throwing, and the distinction is load-bearing on
   * the webhook path. Every other failure is transient, so the caller rethrows and
   * PayPal retries — but a subscription PayPal itself does not recognise will never
   * start existing, so treating that as retryable means retrying forever. Observed for
   * real: PayPal's webhook simulator sends events referencing placeholder ids, and
   * every one of them produced a 500 and an endless retry.
   */
  async getSubscription(subscriptionId: string): Promise<PaypalSubscriptionResource | null> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) {
      logger.warn({ subscriptionId }, "PayPal does not recognise this subscription");
      return null;
    }
    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error({ status: res.status, body: raw }, "PayPal subscription fetch failed");
      throw new AppError(
        "The payment service is temporarily unavailable. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    return (await res.json()) as PaypalSubscriptionResource;
  }

  /**
   * Cancels immediately and irreversibly.
   *
   * PayPal has no cancel-at-period-end and no resume. We call this straight away so
   * nobody is charged again, and preserve the paid-for remainder locally by leaving
   * `companies.subscription_expires_at` untouched. Deferring the cancel to a cron
   * instead would risk charging someone who already cancelled, and a billing bug that
   * TAKES money is far worse than one that grants a few free days.
   *
   * Treats "already cancelled" (422) as success — the desired end state is reached
   * either way, and surfacing an error there would strand the local row out of step.
   */
  async cancelSubscription(subscriptionId: string, reason: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.slice(0, 128) }),
      },
    );
    if (res.status === 204 || res.ok) return;
    if (res.status === 422) {
      logger.warn(
        { subscriptionId },
        "PayPal reports subscription already inactive — treating as cancelled",
      );
      return;
    }
    const { raw } = await parsePaypalError(res);
    logger.error({ status: res.status, body: raw }, "PayPal subscription cancel failed");
    throw new AppError(
      "We couldn't cancel that subscription. Please try again shortly.",
      502,
      PAYMENT_PROVIDER_ERROR,
    );
  }

  /**
   * Changes the plan on a live subscription. Returns an approval URL when PayPal wants
   * the buyer to re-confirm (it usually does for a price increase).
   *
   * **PayPal does not prorate.** The change takes effect at the next billing cycle, and
   * the effective date varies by funding source — so the caller must read
   * `next_billing_time` back from PayPal afterwards rather than computing it. Never
   * promise the customer a date we worked out ourselves.
   */
  async reviseSubscription(opts: {
    subscriptionId: string;
    paypalPlanId: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ approvalUrl: string | null }> {
    const token = await this.getAccessToken();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(opts.subscriptionId)}/revise`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: opts.paypalPlanId,
          application_context: {
            brand_name: "KIMates",
            return_url: opts.returnUrl,
            cancel_url: opts.cancelUrl,
            shipping_preference: "NO_SHIPPING",
          },
        }),
      },
    );
    if (!res.ok) {
      const { raw } = await parsePaypalError(res);
      logger.error({ status: res.status, body: raw }, "PayPal subscription revise failed");
      throw new AppError(
        "We couldn't change that plan. Please try again shortly.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }
    const data = (await res.json()) as { links?: { rel: string; href: string }[] };
    return { approvalUrl: data.links?.find((l) => l.rel === "approve")?.href ?? null };
  }
}
