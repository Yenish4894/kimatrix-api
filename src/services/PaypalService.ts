import { config } from "@/config/index";
import { logger } from "@/utils/logger";

interface PaypalTokenResponse {
  access_token: string;
  expires_in: number;
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
      const body = await res.text();
      logger.error({ status: res.status, body }, "PayPal token fetch failed");
      throw new Error("Failed to obtain PayPal access token");
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
      const body = await res.text();
      logger.error({ status: res.status, body }, "PayPal create-order failed");
      throw new Error("Failed to create PayPal order");
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
      const body = await res.text();
      logger.error({ status: res.status, body, orderId }, "PayPal capture failed");
      throw new Error("Failed to capture PayPal order");
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
