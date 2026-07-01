import { createSign, randomBytes } from 'node:crypto';
import { ApiError } from '../utils/errors.js';
import type {
  PaymentProviderAdapter,
  ProviderCreatePaymentInput,
  ProviderCreatePaymentResult,
  ProviderHandleWebhookInput,
  ProviderHandleWebhookResult,
  ProviderRefundPaymentInput,
  ProviderRefundPaymentResult,
  ProviderVerifyPaymentInput,
  ProviderVerifyPaymentResult
} from './base.js';

type NagadConfig = {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  baseUrl: string;
  callbackUrl?: string;
  timeoutMs: number;
  sandbox: boolean;
};

const readCredential = (credentials: Record<string, string>, ...keys: string[]) => {
  for (const key of keys) {
    const exact = credentials[key];
    if (typeof exact === 'string' && exact.trim().length > 0) {
      return exact.trim();
    }

    const lowerKey = key.toLowerCase();
    const match = Object.entries(credentials).find(([entryKey]) => entryKey.toLowerCase() === lowerKey);
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  return null;
};

const parseBoolean = (value: string | null) => {
  if (value === null) {
    return null;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const parseTimeout = (value: string | null) => {
  if (value === null) {
    return 30_000;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return 30_000;
  }

  return Math.min(parsed, 120_000);
};

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, '');

const payloadString = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const parsePayload = (rawBody: string) => {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {} as Record<string, unknown>;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(trimmed));
  }
};

const safeRawResponse = (payload: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key]) => {
      const normalized = key.toLowerCase();
      return !normalized.includes('private') && !normalized.includes('publickey') && !normalized.includes('signature') && !normalized.includes('token') && !normalized.includes('authorization');
    })
  );

const toSafeErrorMessage = (value: unknown, fallback: string) => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return fallback;
};

const recursivelySortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => recursivelySortObject(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = recursivelySortObject((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
};

const buildDateTime = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
};

const generateChallenge = () => randomBytes(16).toString('hex');

const createSignature = (payload: Record<string, unknown>, privateKey: string) => {
  const sortedPayload = recursivelySortObject(payload);
  const serialized = JSON.stringify(sortedPayload);
  const signer = createSign('RSA-SHA256');
  signer.update(serialized, 'utf8');
  signer.end();
  return signer.sign(privateKey, 'base64');
};

const readConfig = (
  credentials: Record<string, string>,
  providerEnvironment?: 'SANDBOX' | 'PRODUCTION'
): NagadConfig => {
  const merchantId = readCredential(credentials, 'merchantId', 'merchant_id');
  const publicKey = readCredential(credentials, 'publicKey', 'public_key');
  const privateKey = readCredential(credentials, 'privateKey', 'private_key');
  const baseUrl = readCredential(credentials, 'baseUrl', 'base_url');
  const callbackUrl = readCredential(credentials, 'callbackUrl', 'callback_url') ?? undefined;
  const sandbox = parseBoolean(readCredential(credentials, 'sandbox')) ?? providerEnvironment !== 'PRODUCTION';
  const timeoutMs = parseTimeout(readCredential(credentials, 'timeoutMs', 'timeout_ms'));

  if (!merchantId || !publicKey || !privateKey || !baseUrl) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'NAGAD provider credentials are not configured');
  }

  return {
    merchantId,
    publicKey,
    privateKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    callbackUrl,
    timeoutMs,
    sandbox
  };
};

const buildEndpoints = (config: NagadConfig) => ({
  initialize: `${config.baseUrl}/remote-payment-gateway-1.0/api/dfs/check-out/initialize/${config.merchantId}`,
  complete: (paymentRefId: string) => `${config.baseUrl}/remote-payment-gateway-1.0/api/dfs/check-out/complete/${encodeURIComponent(paymentRefId)}`,
  verify: (paymentRefId: string) => `${config.baseUrl}/api/dfs/verify/payment/${encodeURIComponent(paymentRefId)}`
});

const requestJson = async <T>(input: {
  url: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: unknown;
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(input.headers ?? {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal
    });

    const rawText = await response.text();
    const parsed = rawText.length > 0 ? (JSON.parse(rawText) as T) : ({} as T);

    return {
      ok: response.ok,
      status: response.status,
      data: parsed
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(504, 'PROVIDER_TIMEOUT', 'NAGAD request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const buildHeaders = (payload: Record<string, unknown>, config: NagadConfig) => ({
  'X-KM-IP-V4': '127.0.0.1',
  'X-KM-Client-Type': 'PC_WEB',
  'X-KM-Api-Version': 'v-0.2.0',
  'X-KM-Signature': createSignature(payload, config.privateKey)
});

const mapProviderError = (
  payload: Record<string, unknown>,
  fallbackMessage: string,
  defaultCode: 'PROVIDER_INIT_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR' = 'PROVIDER_ERROR'
) => {
  const status = payloadString(payload, 'status', 'message');
  const statusCode = payloadString(payload, 'statusCode', 'code');
  const message = toSafeErrorMessage(payload.message ?? payload.reason ?? payload.error ?? status, fallbackMessage);

  if (statusCode === '000' || statusCode === '00_0000_000') {
    return new ApiError(502, defaultCode, message);
  }

  if (status && ['failed', 'cancelled', 'canceled', 'error'].includes(status.toLowerCase())) {
    return new ApiError(defaultCode === 'PROVIDER_UNAVAILABLE' ? 503 : 422, defaultCode, message);
  }

  return new ApiError(defaultCode === 'PROVIDER_UNAVAILABLE' ? 503 : 422, defaultCode, message);
};

const mapNagadStatus = (payload: Record<string, unknown>): ProviderVerifyPaymentResult['status'] => {
  const status = payloadString(payload, 'status', 'transactionStatus')?.toLowerCase() ?? '';
  const statusCode = payloadString(payload, 'statusCode') ?? '';

  if ((status === 'success' || status === 'successful') && (statusCode === '000' || statusCode === '00_0000_000' || statusCode === '00_000_000')) {
    return 'SUCCESS';
  }

  if (['failed', 'cancelled', 'canceled', 'reversed'].includes(status)) {
    return 'FAILED';
  }

  return 'PENDING';
};

export class NAGADProviderAdapter implements PaymentProviderAdapter {
  async createPayment(input: ProviderCreatePaymentInput): Promise<ProviderCreatePaymentResult> {
    const config = readConfig(input.credentials, input.providerEnvironment);
    if (input.currency.toUpperCase() !== 'BDT') {
      throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'NAGAD only supports BDT payments');
    }

    const endpoints = buildEndpoints(config);
    const callbackUrl = input.callbackUrl || config.callbackUrl;
    const orderId = `${input.orderId}`.slice(0, 20);
    const challenge = generateChallenge();
    const dateTime = buildDateTime();

    if (!callbackUrl) {
      throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'NAGAD callback URL is not configured');
    }

    const initializePayload = {
      merchantId: config.merchantId,
      orderId,
      challenge,
      locale: 'en'
    };

    const initializeResponse = await requestJson<Record<string, unknown>>({
      url: `${endpoints.initialize}/${encodeURIComponent(orderId)}?locale=en`,
      method: 'POST',
      timeoutMs: config.timeoutMs,
      headers: buildHeaders(initializePayload, config),
      body: initializePayload
    });

    if (!initializeResponse.ok) {
      throw mapProviderError(initializeResponse.data, 'NAGAD payment initialization failed', 'PROVIDER_INIT_FAILED');
    }

    const paymentRefId =
      payloadString(initializeResponse.data, 'paymentRefId', 'payment_ref_id', 'paymentReferenceId') ??
      payloadString((initializeResponse.data.sensitiveData as Record<string, unknown>) ?? {}, 'paymentReferenceId', 'paymentRefId', 'payment_ref_id');

    const completionChallenge =
      payloadString(initializeResponse.data, 'challenge') ??
      payloadString((initializeResponse.data.sensitiveData as Record<string, unknown>) ?? {}, 'challenge') ??
      challenge;

    if (!paymentRefId) {
      throw new ApiError(502, 'PROVIDER_ERROR', 'NAGAD did not return a payment reference ID');
    }

    const completePayload = {
      merchantId: config.merchantId,
      orderId,
      amount: input.amountDecimal,
      currencyCode: '050',
      challenge: completionChallenge,
      merchantCallbackURL: callbackUrl,
      productName: input.purpose?.trim() || `WPA payment ${orderId}`,
      additionalMerchantInfo: {
        sessionId: input.sessionId,
        merchantId: input.merchantId
      },
      customerName: input.customer.name.trim() || 'Customer',
      customerEmail: input.customer.email.trim(),
      merchantAdditionalInfo: {
        purpose: input.purpose
      },
      requestDateTime: dateTime
    };

    const completeResponse = await requestJson<Record<string, unknown>>({
      url: endpoints.complete(paymentRefId),
      method: 'POST',
      timeoutMs: config.timeoutMs,
      headers: buildHeaders(completePayload, config),
      body: completePayload
    });

    if (!completeResponse.ok) {
      throw mapProviderError(completeResponse.data, 'NAGAD payment completion failed', 'PROVIDER_INIT_FAILED');
    }

    const checkoutUrl =
      payloadString(completeResponse.data, 'callBackUrl', 'callbackUrl', 'redirectGatewayURL', 'paymentUrl') ??
      `${config.baseUrl}/check-out/${encodeURIComponent(paymentRefId)}`;

    return {
      providerSessionId: paymentRefId,
      providerReference: orderId,
      checkoutToken: paymentRefId,
      rawResponse: {
        provider: 'NAGAD',
        sandbox: config.sandbox,
        paymentRefId,
        checkoutUrl,
        orderId,
        status: payloadString(completeResponse.data, 'status') ?? payloadString(initializeResponse.data, 'status') ?? null,
        statusCode: payloadString(completeResponse.data, 'statusCode') ?? payloadString(initializeResponse.data, 'statusCode') ?? null
      }
    };
  }

  async verifyPayment(input: ProviderVerifyPaymentInput): Promise<ProviderVerifyPaymentResult> {
    const config = readConfig(input.credentials);
    const paymentRefId = input.providerSessionId ?? input.providerTransactionId ?? input.providerReference;

    if (!paymentRefId) {
      throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'NAGAD verification requires a payment reference ID');
    }

    const endpoints = buildEndpoints(config);
    const response = await requestJson<Record<string, unknown>>({
      url: endpoints.verify(paymentRefId),
      method: 'GET',
      timeoutMs: config.timeoutMs,
      headers: {
        'X-KM-Client-Type': 'PC_WEB',
        'X-KM-Api-Version': 'v-0.2.0'
      }
    });

    if (!response.ok) {
      throw mapProviderError(response.data, 'NAGAD verification failed');
    }

    return {
      status: mapNagadStatus(response.data),
      providerReference: payloadString(response.data, 'orderId', 'order_id') ?? input.providerReference,
      providerSessionId: payloadString(response.data, 'paymentRefId', 'payment_ref_id') ?? paymentRefId,
      rawResponse: {
        provider: 'NAGAD',
        merchantId: payloadString(response.data, 'merchantId') ?? null,
        orderId: payloadString(response.data, 'orderId', 'order_id') ?? input.providerReference,
        paymentRefId: payloadString(response.data, 'paymentRefId', 'payment_ref_id') ?? paymentRefId,
        amount: payloadString(response.data, 'amount') ?? null,
        status: payloadString(response.data, 'status') ?? null,
        statusCode: payloadString(response.data, 'statusCode') ?? null,
        issuerPaymentRefNo: payloadString(response.data, 'issuerPaymentRefNo', 'issuer_payment_ref') ?? null,
        paymentDateTime: payloadString(response.data, 'issuerPaymentDateTime', 'payment_dt') ?? null
      }
    };
  }

  async handleWebhook(input: ProviderHandleWebhookInput): Promise<ProviderHandleWebhookResult> {
    const payload = parsePayload(input.rawBody);
    const paymentRefId = payloadString(payload, 'payment_ref_id', 'paymentRefId');
    const orderId = payloadString(payload, 'order_id', 'orderId');
    const callbackStatus = payloadString(payload, 'status');
    const statusCode = payloadString(payload, 'status_code', 'statusCode');
    const providerEventId = [paymentRefId ?? orderId ?? 'unknown', callbackStatus ?? 'unknown', statusCode ?? 'na'].join(':');

    if (!paymentRefId) {
      return {
        isVerified: false,
        providerEventId,
        merchantOrderId: orderId,
        status: 'PENDING',
        payload: {
          provider: 'NAGAD',
          verified: false,
          reason: 'missing_payment_ref_id',
          callback: safeRawResponse(payload)
        }
      };
    }

    try {
      const verification = await this.verifyPayment({
        providerReference: orderId ?? paymentRefId,
        providerSessionId: paymentRefId,
        providerTransactionId: paymentRefId,
        credentials: input.credentials
      });

      const mappedStatus =
        verification.status === 'SUCCESS'
          ? 'SUCCESS'
          : ['failed'].includes((callbackStatus ?? '').toLowerCase())
            ? 'FAILED'
            : ['cancelled', 'canceled'].includes((callbackStatus ?? '').toLowerCase())
              ? 'CANCELLED'
              : verification.status === 'FAILED'
                ? 'FAILED'
                : 'PENDING';

      return {
        isVerified: verification.status !== 'PENDING',
        providerEventId,
        merchantOrderId: orderId,
        providerReference: verification.providerReference,
        providerSessionId: verification.providerSessionId ?? paymentRefId,
        status: mappedStatus,
        payload: {
          provider: 'NAGAD',
          verified: verification.status !== 'PENDING',
          callbackStatus: callbackStatus ?? null,
          statusCode: statusCode ?? null,
          callback: safeRawResponse(payload),
          verification: verification.rawResponse
        }
      };
    } catch (error) {
      return {
        isVerified: false,
        providerEventId,
        merchantOrderId: orderId,
        providerReference: orderId ?? paymentRefId,
        providerSessionId: paymentRefId,
        status: 'PENDING',
        payload: {
          provider: 'NAGAD',
          verified: false,
          callback: safeRawResponse(payload),
          error: error instanceof Error ? error.message : 'verification_failed'
        }
      };
    }
  }

  async refundPayment(_input: ProviderRefundPaymentInput): Promise<ProviderRefundPaymentResult> {
    throw new ApiError(501, 'PROVIDER_ERROR', 'NAGAD refund API is not implemented yet');
  }
}
