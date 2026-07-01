/**
 * WPA Payment Gateway — Zero-dependency TypeScript SDK helper.
 * Requires Node.js 18+ (built-in crypto and fetch).
 *
 * Copy this file into your backend project. No npm install needed.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaymentSessionRequest {
  clientId: string;
  merchantOrderId: string;
  /** Integer — smallest currency unit (e.g. cents for USD: $49.99 → 4999) */
  amount: number;
  /** ISO 4217, e.g. "USD" */
  currency: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  description?: string;
  successUrl: string;
  callbackUrl: string;
  cancelUrl?: string;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentSessionResponse {
  success: boolean;
  session: {
    id: string;
    reference: string;
    status: 'PENDING';
    amount: number;
    currency: string;
    merchantOrderId: string;
    /** Relative path — prepend gatewayUrl to get the full URL */
    paymentUrl: string;
    expiresAt: string | null;
  };
}

export interface GatewayWebhookPayload {
  event: 'payment.succeeded' | 'payment.failed' | 'payment.cancelled' | 'payment.pending';
  merchantOrderId: string;
  gatewayReference: string;
  transactionReference: string | null;
  amount: number;
  currency: string;
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'PENDING';
  paidAt: string | null;
  timestamp: number;
  nonce: string;
}

export interface GatewayErrorResponse {
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
  };
}

// ─── Stable JSON ─────────────────────────────────────────────────────────────

function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForJson);
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeForJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Stable JSON: keys sorted alphabetically at every level, no extra whitespace. */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

// ─── Signature ────────────────────────────────────────────────────────────────

/**
 * Build the canonical body string for a payment session request.
 * This is the stable JSON of all request fields (excluding `signature` itself).
 */
export function buildPaymentSessionCanonicalBody(params: PaymentSessionRequest & {
  timestamp: string;
  nonce: string;
}): string {
  const obj: Record<string, unknown> = {
    clientId: params.clientId,
    merchantOrderId: params.merchantOrderId,
    amount: params.amount,
    currency: params.currency,
    customerName: params.customerName,
    timestamp: params.timestamp,
    nonce: params.nonce,
    successUrl: params.successUrl,
    callbackUrl: params.callbackUrl,
    metadata: params.metadata ?? null
  };

  if (params.customerEmail) obj.customerEmail = params.customerEmail;
  if (params.customerPhone) obj.customerPhone = params.customerPhone;
  if (params.description)   obj.description   = params.description;
  if (params.cancelUrl)     obj.cancelUrl     = params.cancelUrl;
  if (params.webhookUrl)    obj.webhookUrl    = params.webhookUrl;

  return stableJsonStringify(obj);
}

/**
 * Compute the HMAC-SHA256 signature for a payment session request.
 *
 * Canonical string format:
 *   METHOD\nPATH\nTIMESTAMP\nSHA256(canonicalBody)
 */
export function createPaymentSessionSignature(params: {
  canonicalBody: string;
  timestamp: string;
  clientSecret: string;
  method?: string;
  path?: string;
}): string {
  const method = (params.method ?? 'POST').toUpperCase();
  const path = params.path ?? '/api/v1/payment-sessions';
  const bodyHash = createHash('sha256').update(params.canonicalBody).digest('hex');
  const canonicalString = `${method}\n${path}\n${params.timestamp}\n${bodyHash}`;

  return createHmac('sha256', params.clientSecret)
    .update(canonicalString)
    .digest('hex');
}

/** Generate a timestamp (Unix seconds) and a cryptographically random nonce. */
export function generateRequestCredentials(): { timestamp: string; nonce: string } {
  return {
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: randomBytes(16).toString('hex')
  };
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

/**
 * Verify a WPA gateway webhook signature.
 *
 * @param rawBody        - Raw request body Buffer or string (do NOT JSON.parse first)
 * @param clientSecret   - Your WPA API key client secret
 * @param signature      - Value of the x-gateway-signature header
 * @returns true if valid
 */
export function verifyGatewayWebhook(
  rawBody: string | Buffer,
  clientSecret: string,
  signature: string
): boolean {
  const expected = createHmac('sha256', clientSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(signature, 'hex');

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

/**
 * Create a WPA payment session.
 * Call this from your backend server — never from a browser.
 *
 * @param gatewayUrl  - Base URL of the WPA Gateway, e.g. "https://gateway.worldpetsassociation.com"
 * @param clientSecret - Your WPA API key client secret
 * @param params       - Payment session parameters
 * @returns The created session with paymentUrl
 */
export async function createPaymentSession(
  gatewayUrl: string,
  clientSecret: string,
  params: PaymentSessionRequest
): Promise<PaymentSessionResponse> {
  const { timestamp, nonce } = generateRequestCredentials();
  const canonicalBody = buildPaymentSessionCanonicalBody({ ...params, timestamp, nonce });
  const signature = createPaymentSessionSignature({ canonicalBody, timestamp, clientSecret });

  const bodyObject = {
    ...JSON.parse(canonicalBody) as Record<string, unknown>,
    signature
  };

  const url = `${gatewayUrl.replace(/\/+$/, '')}/api/v1/payment-sessions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObject)
  });

  const data = await response.json() as PaymentSessionResponse | GatewayErrorResponse;

  if (!response.ok) {
    const err = data as GatewayErrorResponse;
    throw new Error(
      `WPA Gateway error ${response.status} [${err.error?.code ?? 'UNKNOWN'}]: ${err.error?.message ?? 'Unknown error'}`
    );
  }

  return data as PaymentSessionResponse;
}

/**
 * Fetch checkout status without authentication (public endpoint).
 * Use for frontend polling only — not authoritative for order updates.
 */
export async function getCheckoutStatus(
  gatewayUrl: string,
  reference: string
): Promise<{
  reference: string;
  status: string;
  transactionStatus: string | null;
  amount: number;
  currency: string;
  merchantOrderId: string;
  updatedAt: string;
}> {
  const url = `${gatewayUrl.replace(/\/+$/, '')}/api/v1/checkout/${reference}/status`;
  const response = await fetch(url);
  const data = await response.json() as { success: boolean; session: unknown };

  if (!response.ok) {
    throw new Error(`Failed to fetch checkout status: ${response.status}`);
  }

  return data.session as ReturnType<typeof getCheckoutStatus> extends Promise<infer T> ? T : never;
}
