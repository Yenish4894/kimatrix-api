import { config } from "@/config/index";
import { logger } from "@/utils/logger";
import { AppError, BadRequestError } from "@/errors/index";

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

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export class PaypalService {
  private baseUrl: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

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
      if (friendly) throw BadRequestError(friendly);
      throw new AppError(
        "We couldn't complete your PayPal payment. Please try again.",
        502,
        PAYMENT_PROVIDER_ERROR,
      );
    }

    return (await res.json()) as PaypalCaptureResult;
  }

  async verifyWebhookSignature(opts: {
    transmissionId: string;
    transmissionTime: string;
    certUrl: string;
    authAlgo: string;
    transmissionSig: string;
    rawBody: string;
  }): Promise<boolean> {
    // Without a configured webhook ID we cannot verify the signature. Fail
    // loudly with a distinct message so this is never confused with a genuine
    // verification failure (e.g. a spoofed/replayed event).
    if (!config.PAYPAL_WEBHOOK_ID) {
      logger.error(
        "PAYPAL_WEBHOOK_ID is not set — PayPal webhook events cannot be verified and will be ignored. " +
          "Create a webhook in the PayPal dashboard and set PAYPAL_WEBHOOK_ID.",
      );
      return false;
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
          webhook_event: JSON.parse(opts.rawBody) as unknown,
        }),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, "PayPal webhook verification request failed");
      return false;
    }

    const data = (await res.json()) as { verification_status: string };
    return data.verification_status === "SUCCESS";
  }
}
