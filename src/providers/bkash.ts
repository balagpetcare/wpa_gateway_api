import { randomUUID } from 'node:crypto';
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

type BkashConfig = {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  baseUrl: string;
  timeoutMs: number;
  sandbox: boolean;
};

type BkashTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

const DEFAULT_ENDPOINTS = {
  SANDBOX: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout',
  PRODUCTION: 'https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized/checkout'
} as const;

const BKASH_PATHS = {
  GRANT_TOKEN: '/token/grant',
  CREATE_PAYMENT: '/create',
  EXECUTE_PAYMENT: '/execute',
  QUERY_PAYMENT: '/payment/status'
} as const;

const tokenCache = new Map<string, BkashTokenCacheEntry>();

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

const readConfig = (
  credentials: Record<string, string>,
  providerEnvironment?: 'SANDBOX' | 'PRODUCTION'
): BkashConfig => {
  const appKey = readCredential(credentials, 'appKey', 'app_key');
  const appSecret = readCredential(credentials, 'appSecret', 'app_secret');
  const username = readCredential(credentials, 'username', 'userName');
  const password = readCredential(credentials, 'password');
  const sandbox = parseBoolean(readCredential(credentials, 'sandbox')) ?? providerEnvironment !== 'PRODUCTION';
  const baseUrl =
    readCredential(credentials, 'baseUrl', 'base_url') ??
    (sandbox ? DEFAULT_ENDPOINTS.SANDBOX : DEFAULT_ENDPOINTS.PRODUCTION);
  const timeoutMs = parseTimeout(readCredential(credentials, 'timeoutMs', 'timeout_ms'));

  if (!appKey || !appSecret || !username || !password || !baseUrl) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'BKASH provider credentials are not configured');
  }

  return {
    appKey,
    appSecret,
    username,
    password,
    baseUrl: normalizeBaseUrl(baseUrl),
    timeoutMs,
    sandbox
  };
};

const buildEndpoints = (config: BkashConfig) => ({
  grantToken: `${config.baseUrl}${BKASH_PATHS.GRANT_TOKEN}`,
  createPayment: `${config.baseUrl}${BKASH_PATHS.CREATE_PAYMENT}`,
  executePayment: `${config.baseUrl}${BKASH_PATHS.EXECUTE_PAYMENT}`,
  queryPayment: `${config.baseUrl}${BKASH_PATHS.QUERY_PAYMENT}`
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
      data: parsed,
      rawText
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(504, 'PROVIDER_TIMEOUT', 'BKASH request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const toSafeErrorMessage = (value: unknown, fallback: string) => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return fallback;
};

const mapBkashApiError = (
  payload: Record<string, unknown>,
  fallbackMessage: string,
  defaultCode: 'PROVIDER_INIT_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR' = 'PROVIDER_ERROR'
): ApiError => {
  const statusCode = typeof payload.statusCode === 'string' ? payload.statusCode : '';
  const statusMessage = toSafeErrorMessage(payload.statusMessage, fallbackMessage);

  if (statusCode === '0000' || statusCode === '000') {
    return new ApiError(502, defaultCode, statusMessage);
  }

  if (statusCode.includes('2001') || statusCode.includes('2002') || statusCode.includes('2010')) {
    return new ApiError(503, 'PROVIDER_UNAVAILABLE', statusMessage);
  }

  if (statusCode.includes('2023') || statusCode.includes('2062') || statusCode.includes('2057')) {
    return new ApiError(422, 'PROVIDER_INIT_FAILED', statusMessage);
  }

  return new ApiError(defaultCode === 'PROVIDER_UNAVAILABLE' ? 503 : 422, defaultCode, statusMessage);
};

const normalizeBangladeshPhone = (value?: string) => {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) {
    return digits;
  }

  if (digits.length === 11 && digits.startsWith('01')) {
    return `88${digits}`;
  }

  return null;
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

const payloadString = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const buildTokenCacheKey = (config: BkashConfig) => `${config.baseUrl}:${config.username}:${config.appKey}`;

const safeRawResponse = (payload: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key]) => {
      const normalized = key.toLowerCase();
      return !normalized.includes('token') && !normalized.includes('secret') && !normalized.includes('authorization');
    })
  );

const mapQueryOrExecuteStatus = (status: string | undefined): ProviderVerifyPaymentResult['status'] => {
  const normalized = (status ?? '').toLowerCase();

  if (['completed', 'success', 'successful'].includes(normalized)) {
    return 'SUCCESS';
  }

  if (['cancelled', 'canceled', 'failure', 'failed', 'expired', 'reversed'].includes(normalized)) {
    return 'FAILED';
  }

  return 'PENDING';
};

const makeMerchantInvoiceNumber = (input: ProviderCreatePaymentInput) =>
  `${input.orderId}`.slice(0, 255);

const getCachedToken = (config: BkashConfig) => {
  const cached = tokenCache.get(buildTokenCacheKey(config));
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    tokenCache.delete(buildTokenCacheKey(config));
    return null;
  }

  return cached.token;
};

const setCachedToken = (config: BkashConfig, token: string) => {
  tokenCache.set(buildTokenCacheKey(config), {
    token,
    expiresAt: Date.now() + 55 * 60 * 1000
  });
};

const getAuthToken = async (config: BkashConfig) => {
  const cached = getCachedToken(config);
  if (cached) {
    return cached;
  }

  const endpoints = buildEndpoints(config);
  const tokenResponse = await requestJson<Record<string, unknown>>({
    url: endpoints.grantToken,
    method: 'POST',
    timeoutMs: config.timeoutMs,
    headers: {
      username: config.username,
      password: config.password
    },
    body: {
      app_key: config.appKey,
      app_secret: config.appSecret
    }
  });

  const token =
    (typeof tokenResponse.data.id_token === 'string' && tokenResponse.data.id_token) ||
    (typeof tokenResponse.data.access_token === 'string' && tokenResponse.data.access_token) ||
    (typeof tokenResponse.data.token === 'string' && tokenResponse.data.token) ||
    null;

  const responseCode = typeof tokenResponse.data.statusCode === 'string' ? tokenResponse.data.statusCode : null;
  if (!tokenResponse.ok || !token || (responseCode && responseCode !== '0000')) {
    throw mapBkashApiError(tokenResponse.data, 'BKASH authentication failed', 'PROVIDER_UNAVAILABLE');
  }

  setCachedToken(config, token);
  return token;
};

const authorizedHeaders = async (config: BkashConfig) => {
  const token = await getAuthToken(config);
  return {
    authorization: token,
    'x-app-key': config.appKey
  };
};

const queryPayment = async (config: BkashConfig, paymentID: string) => {
  const endpoints = buildEndpoints(config);
  const headers = await authorizedHeaders(config);

  const response = await requestJson<Record<string, unknown>>({
    url: `${endpoints.queryPayment}?paymentID=${encodeURIComponent(paymentID)}`,
    method: 'GET',
    timeoutMs: config.timeoutMs,
    headers
  });

  if (!response.ok) {
    throw mapBkashApiError(response.data, 'BKASH payment query failed');
  }

  return response.data;
};

const executePayment = async (config: BkashConfig, paymentID: string) => {
  const endpoints = buildEndpoints(config);
  const headers = await authorizedHeaders(config);

  const response = await requestJson<Record<string, unknown>>({
    url: endpoints.executePayment,
    method: 'POST',
    timeoutMs: config.timeoutMs,
    headers,
    body: {
      paymentID
    }
  });

  if (!response.ok) {
    throw mapBkashApiError(response.data, 'BKASH payment execution failed');
  }

  return response.data;
};

export class BKASHProviderAdapter implements PaymentProviderAdapter {
  async createPayment(input: ProviderCreatePaymentInput): Promise<ProviderCreatePaymentResult> {
    const config = readConfig(input.credentials, input.providerEnvironment);
    if (input.currency.toUpperCase() !== 'BDT') {
      throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'BKASH only supports BDT payments');
    }

    const payerReference = normalizeBangladeshPhone(input.customer.phone) ?? input.sessionId.slice(0, 20);
    const merchantInvoiceNumber = makeMerchantInvoiceNumber(input);
    const endpoints = buildEndpoints(config);
    const headers = await authorizedHeaders(config);

    const createResponse = await requestJson<Record<string, unknown>>({
      url: endpoints.createPayment,
      method: 'POST',
      timeoutMs: config.timeoutMs,
      headers,
      body: {
        mode: '0011',
        payerReference,
        callbackURL: input.callbackUrl,
        amount: input.amountDecimal,
        currency: input.currency.toUpperCase(),
        intent: 'sale',
        merchantInvoiceNumber
      }
    });

    const responseCode = typeof createResponse.data.statusCode === 'string' ? createResponse.data.statusCode : null;
    if (!createResponse.ok || (responseCode && responseCode !== '0000')) {
      throw mapBkashApiError(createResponse.data, 'BKASH payment initialization failed', 'PROVIDER_INIT_FAILED');
    }

    const paymentID = payloadString(createResponse.data, 'paymentID');
    const bkashURL = payloadString(createResponse.data, 'bkashURL');

    if (!paymentID || !bkashURL) {
      throw new ApiError(502, 'PROVIDER_ERROR', 'BKASH did not return a payment ID or redirect URL');
    }

    return {
      providerSessionId: paymentID,
      providerReference: merchantInvoiceNumber,
      checkoutToken: paymentID,
      rawResponse: {
        provider: 'BKASH',
        sandbox: config.sandbox,
        paymentId: paymentID,
        paymentUrl: bkashURL,
        merchantInvoiceNumber,
        statusCode: responseCode ?? null,
        statusMessage: payloadString(createResponse.data, 'statusMessage') ?? null
      }
    };
  }

  async verifyPayment(input: ProviderVerifyPaymentInput): Promise<ProviderVerifyPaymentResult> {
    const config = readConfig(input.credentials);
    const paymentID = input.providerSessionId ?? input.providerTransactionId ?? input.providerReference;

    if (!paymentID) {
      throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'BKASH verification requires a payment ID');
    }

    let response: Record<string, unknown>;
    try {
      response = await executePayment(config, paymentID);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.code !== 'PROVIDER_INIT_FAILED' && error.code !== 'PROVIDER_ERROR')) {
        throw error;
      }

      response = await queryPayment(config, paymentID);
    }

    const transactionStatus = payloadString(response, 'transactionStatus', 'status');
    const providerReference = payloadString(response, 'trxID', 'merchantInvoiceNumber') ?? input.providerReference;

    return {
      status: mapQueryOrExecuteStatus(transactionStatus),
      providerReference,
      providerSessionId: payloadString(response, 'paymentID') ?? paymentID,
      rawResponse: {
        provider: 'BKASH',
        paymentId: payloadString(response, 'paymentID') ?? paymentID,
        trxId: payloadString(response, 'trxID') ?? null,
        merchantInvoiceNumber: payloadString(response, 'merchantInvoiceNumber') ?? input.providerReference,
        transactionStatus: transactionStatus ?? null,
        statusCode: payloadString(response, 'statusCode') ?? null,
        statusMessage: payloadString(response, 'statusMessage') ?? null
      }
    };
  }

  async handleWebhook(input: ProviderHandleWebhookInput): Promise<ProviderHandleWebhookResult> {
    const payload = parsePayload(input.rawBody);
    const callbackStatus = payloadString(payload, 'status', 'transactionStatus');
    const paymentID = payloadString(payload, 'paymentID');
    const signature = payloadString(payload, 'signature');
    const providerEventId = [paymentID ?? 'unknown', callbackStatus ?? 'unknown', signature ?? randomUUID()].join(':');

    if (!paymentID) {
      return {
        isVerified: false,
        providerEventId,
        status: 'PENDING',
        payload: {
          provider: 'BKASH',
          verified: false,
          reason: 'missing_payment_id'
        }
      };
    }

    try {
      const verification = await this.verifyPayment({
        providerReference: payloadString(payload, 'merchantInvoiceNumber') ?? paymentID,
        providerSessionId: paymentID,
        credentials: input.credentials
      });

      const mappedStatus =
        verification.status === 'SUCCESS'
          ? 'SUCCESS'
          : ['cancel', 'cancelled', 'canceled'].includes((callbackStatus ?? '').toLowerCase())
            ? 'CANCELLED'
            : ['failure', 'failed'].includes((callbackStatus ?? '').toLowerCase())
              ? 'FAILED'
              : verification.status === 'FAILED'
                ? 'FAILED'
                : 'PENDING';

      return {
        isVerified: verification.status === 'SUCCESS' || verification.status === 'FAILED' || mappedStatus === 'CANCELLED',
        providerEventId,
        merchantOrderId: payloadString(payload, 'merchantInvoiceNumber'),
        providerReference: verification.providerReference,
        providerSessionId: verification.providerSessionId ?? paymentID,
        status: mappedStatus,
        payload: {
          provider: 'BKASH',
          callbackStatus: callbackStatus ?? null,
          verified: verification.status !== 'PENDING',
          callback: safeRawResponse(payload),
          verification: verification.rawResponse
        }
      };
    } catch (error) {
      return {
        isVerified: false,
        providerEventId,
        merchantOrderId: payloadString(payload, 'merchantInvoiceNumber'),
        providerSessionId: paymentID,
        status: 'PENDING',
        payload: {
          provider: 'BKASH',
          verified: false,
          reason: error instanceof Error ? error.message : 'verification_failed',
          callback: safeRawResponse(payload)
        }
      };
    }
  }

  async refundPayment(_input: ProviderRefundPaymentInput): Promise<ProviderRefundPaymentResult> {
    throw new ApiError(501, 'PROVIDER_ERROR', 'BKASH refund is not implemented yet');
  }
}
