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

type SSLCommerzConfig = {
  storeId: string;
  storePassword: string;
  baseUrl: string;
  ipnUrl?: string;
  timeoutMs: number;
  sandbox: boolean;
};

const DEFAULT_ENDPOINTS = {
  SANDBOX: 'https://sandbox.sslcommerz.com',
  PRODUCTION: 'https://securepay.sslcommerz.com'
} as const;

const SSLCOMMERZ_PATHS = {
  CREATE_SESSION: '/gwprocess/v4/api.php',
  VALIDATE_BY_VAL_ID: '/validator/api/validationserverAPI.php',
  VALIDATE_BY_TRANSACTION: '/validator/api/merchantTransIDvalidationAPI.php'
} as const;

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

const normalizePhone = (value?: string) => {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length >= 12) {
    return digits;
  }

  if (digits.startsWith('0')) {
    return digits;
  }

  return digits.length > 0 ? digits : null;
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

const toSafeErrorMessage = (value: unknown, fallback: string) => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return fallback;
};

const safeRawResponse = (payload: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key]) => {
      const normalized = key.toLowerCase();
      return !normalized.includes('password') && !normalized.includes('secret') && !normalized.includes('token') && !normalized.includes('authorization');
    })
  );

const readConfig = (
  credentials: Record<string, string>,
  providerEnvironment?: 'SANDBOX' | 'PRODUCTION'
): SSLCommerzConfig => {
  const storeId = readCredential(credentials, 'storeId', 'store_id');
  const storePassword = readCredential(credentials, 'storePassword', 'store_passwd', 'store_passwd');
  const sandbox = parseBoolean(readCredential(credentials, 'sandbox')) ?? providerEnvironment !== 'PRODUCTION';
  const baseUrl =
    readCredential(credentials, 'baseUrl', 'base_url') ??
    (sandbox ? DEFAULT_ENDPOINTS.SANDBOX : DEFAULT_ENDPOINTS.PRODUCTION);
  const ipnUrl = readCredential(credentials, 'ipnUrl', 'ipn_url', 'callbackUrl', 'callback_url') ?? undefined;
  const timeoutMs = parseTimeout(readCredential(credentials, 'timeoutMs', 'timeout_ms'));

  if (!storeId || !storePassword || !baseUrl) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'SSLCOMMERZ provider credentials are not configured');
  }

  return {
    storeId,
    storePassword,
    baseUrl: normalizeBaseUrl(baseUrl),
    ipnUrl,
    timeoutMs,
    sandbox
  };
};

const buildEndpoints = (config: SSLCommerzConfig) => ({
  createSession: `${config.baseUrl}${SSLCOMMERZ_PATHS.CREATE_SESSION}`,
  validateByValId: `${config.baseUrl}${SSLCOMMERZ_PATHS.VALIDATE_BY_VAL_ID}`,
  validateByTransaction: `${config.baseUrl}${SSLCOMMERZ_PATHS.VALIDATE_BY_TRANSACTION}`
});

const requestForm = async <T>(input: {
  url: string;
  timeoutMs: number;
  body: Record<string, string>;
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(input.body).toString(),
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
      throw new ApiError(504, 'PROVIDER_TIMEOUT', 'SSLCOMMERZ request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const requestJson = async <T>(input: {
  url: string;
  timeoutMs: number;
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
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
      throw new ApiError(504, 'PROVIDER_TIMEOUT', 'SSLCOMMERZ request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const mapProviderError = (
  payload: Record<string, unknown>,
  fallbackMessage: string,
  defaultCode: 'PROVIDER_INIT_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR' = 'PROVIDER_ERROR'
) => {
  const status = payloadString(payload, 'status', 'APIConnect', 'failedreason');
  const message = toSafeErrorMessage(payload.failedreason ?? payload.error ?? payload.status, fallbackMessage);

  if (!status || ['failed', 'failed_to_connect', 'invalid_request', 'error'].includes(status.toLowerCase())) {
    return new ApiError(defaultCode === 'PROVIDER_UNAVAILABLE' ? 503 : 422, defaultCode, message);
  }

  if (status.toLowerCase() === 'failed') {
    return new ApiError(422, 'PROVIDER_INIT_FAILED', message);
  }

  if (status.toLowerCase() === 'invalid_transaction') {
    return new ApiError(422, 'PROVIDER_ERROR', message);
  }

  return new ApiError(defaultCode === 'PROVIDER_UNAVAILABLE' ? 503 : 422, defaultCode, message);
};

const mapValidationStatus = (payload: Record<string, unknown>): ProviderVerifyPaymentResult['status'] => {
  const status = payloadString(payload, 'status')?.toLowerCase() ?? '';
  const apiConnect = payloadString(payload, 'APIConnect')?.toLowerCase() ?? '';

  if (apiConnect && apiConnect !== 'done') {
    return 'PENDING';
  }

  if (['valid', 'validated', 'success', 'successful'].includes(status)) {
    return 'SUCCESS';
  }

  if (['failed', 'cancelled', 'canceled', 'invalid_transaction'].includes(status)) {
    return 'FAILED';
  }

  return 'PENDING';
};

const buildValidationUrl = (baseUrl: string, params: Record<string, string>) => {
  const target = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }

  return target.toString();
};

const validateByValId = async (config: SSLCommerzConfig, valId: string) => {
  const endpoints = buildEndpoints(config);
  const response = await requestJson<Record<string, unknown>>({
    url: buildValidationUrl(endpoints.validateByValId, {
      val_id: valId,
      store_id: config.storeId,
      store_passwd: config.storePassword,
      v: '1',
      format: 'json'
    }),
    timeoutMs: config.timeoutMs
  });

  if (!response.ok) {
    throw mapProviderError(response.data, 'SSLCOMMERZ validation failed');
  }

  return response.data;
};

const validateByTransaction = async (config: SSLCommerzConfig, params: { tranId?: string; sessionKey?: string }) => {
  const endpoints = buildEndpoints(config);
  const query: Record<string, string> | null = params.tranId
    ? {
        tran_id: params.tranId,
        store_id: config.storeId,
        store_passwd: config.storePassword,
        v: '1',
        format: 'json'
      }
    : params.sessionKey
      ? {
          sessionkey: params.sessionKey,
          store_id: config.storeId,
          store_passwd: config.storePassword,
          v: '1',
          format: 'json'
        }
      : null;

  if (!query) {
    throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'SSLCOMMERZ verification requires a val_id, tran_id, or session key');
  }

  const response = await requestJson<Record<string, unknown>>({
    url: buildValidationUrl(endpoints.validateByTransaction, query),
    timeoutMs: config.timeoutMs
  });

  if (!response.ok) {
    throw mapProviderError(response.data, 'SSLCOMMERZ transaction validation failed');
  }

  const element = Array.isArray(response.data.element) ? response.data.element[0] : null;
  if (element && typeof element === 'object' && !Array.isArray(element)) {
    return element as Record<string, unknown>;
  }

  return response.data;
};

export class SSLCOMMERZProviderAdapter implements PaymentProviderAdapter {
  async createPayment(input: ProviderCreatePaymentInput): Promise<ProviderCreatePaymentResult> {
    const config = readConfig(input.credentials, input.providerEnvironment);
    const endpoints = buildEndpoints(config);
    const providerReference = `${input.orderId}`.slice(0, 30);
    const ipnUrl = config.ipnUrl ?? input.callbackUrl;
    const customerName = input.customer.name.trim() || 'Customer';
    const customerEmail = input.customer.email.trim();
    const customerPhone = normalizePhone(input.customer.phone) ?? '';

    const createResponse = await requestForm<Record<string, unknown>>({
      url: endpoints.createSession,
      timeoutMs: config.timeoutMs,
      body: {
        store_id: config.storeId,
        store_passwd: config.storePassword,
        total_amount: input.amountDecimal,
        currency: input.currency.toUpperCase(),
        tran_id: providerReference,
        success_url: input.successUrl,
        fail_url: input.cancelUrl,
        cancel_url: input.cancelUrl,
        ipn_url: ipnUrl,
        product_category: input.purpose?.trim() || 'general',
        product_name: input.purpose?.trim() || `WPA payment ${input.orderId}`,
        product_profile: 'general',
        cus_name: customerName,
        cus_email: customerEmail,
        cus_add1: input.purpose?.trim() || 'Payment request',
        cus_add2: '',
        cus_city: input.customer.country?.trim() || 'Dhaka',
        cus_state: input.customer.country?.trim() || 'Dhaka',
        cus_postcode: '1200',
        cus_country: input.country?.trim() || input.customer.country?.trim() || 'Bangladesh',
        cus_phone: customerPhone,
        cus_fax: customerPhone,
        ship_name: customerName,
        ship_add1: input.purpose?.trim() || 'Payment request',
        ship_add2: '',
        ship_city: input.customer.country?.trim() || 'Dhaka',
        ship_state: input.customer.country?.trim() || 'Dhaka',
        ship_postcode: '1200',
        ship_country: input.country?.trim() || input.customer.country?.trim() || 'Bangladesh',
        value_a: input.sessionId,
        value_b: input.merchantId,
        value_c: input.orderId,
        value_d: input.currency.toUpperCase()
      }
    });

    const responseStatus = payloadString(createResponse.data, 'status')?.toUpperCase() ?? '';
    if (!createResponse.ok || responseStatus !== 'SUCCESS') {
      throw mapProviderError(createResponse.data, 'SSLCOMMERZ payment initialization failed', 'PROVIDER_INIT_FAILED');
    }

    const providerSessionId = payloadString(createResponse.data, 'sessionkey');
    const checkoutUrl = payloadString(createResponse.data, 'GatewayPageURL');

    if (!providerSessionId || !checkoutUrl) {
      throw new ApiError(502, 'PROVIDER_ERROR', 'SSLCOMMERZ did not return a session key or checkout URL');
    }

    return {
      providerSessionId,
      providerReference,
      checkoutToken: providerSessionId,
      rawResponse: {
        provider: 'SSLCOMMERZ',
        sandbox: config.sandbox,
        sessionKey: providerSessionId,
        checkoutUrl,
        status: responseStatus,
        failedReason: payloadString(createResponse.data, 'failedreason') ?? null,
        gatewayOptions: safeRawResponse(createResponse.data)
      }
    };
  }

  async verifyPayment(input: ProviderVerifyPaymentInput): Promise<ProviderVerifyPaymentResult> {
    const config = readConfig(input.credentials);
    const providerValidationId = input.providerTransactionId;

    const response = providerValidationId
      ? await validateByValId(config, providerValidationId)
      : await validateByTransaction(config, {
          tranId: input.providerReference,
          sessionKey: input.providerSessionId
        });

    const providerReference = payloadString(response, 'tran_id') ?? input.providerReference;
    const providerSessionId = payloadString(response, 'sessionkey') ?? input.providerSessionId;

    return {
      status: mapValidationStatus(response),
      providerReference,
      providerSessionId,
      rawResponse: {
        provider: 'SSLCOMMERZ',
        status: payloadString(response, 'status') ?? null,
        apiConnect: payloadString(response, 'APIConnect') ?? null,
        validationId: payloadString(response, 'val_id') ?? providerValidationId ?? null,
        transactionId: providerReference,
        sessionKey: providerSessionId ?? null,
        bankTransactionId: payloadString(response, 'bank_tran_id') ?? null,
        amount: payloadString(response, 'amount') ?? null,
        currency: payloadString(response, 'currency', 'currency_type') ?? null,
        riskLevel: payloadString(response, 'risk_level') ?? null,
        riskTitle: payloadString(response, 'risk_title') ?? null,
        error: payloadString(response, 'error') ?? null
      }
    };
  }

  async handleWebhook(input: ProviderHandleWebhookInput): Promise<ProviderHandleWebhookResult> {
    const payload = parsePayload(input.rawBody);
    const valId = payloadString(payload, 'val_id');
    const tranId = payloadString(payload, 'tran_id');
    const sessionKey = payloadString(payload, 'sessionkey');
    const providerEventId = [valId ?? tranId ?? sessionKey ?? 'unknown', payloadString(payload, 'status') ?? 'unknown'].join(':');

    if (!valId && !tranId && !sessionKey) {
      return {
        isVerified: false,
        providerEventId,
        status: 'PENDING',
        payload: {
          provider: 'SSLCOMMERZ',
          verified: false,
          reason: 'missing_validation_reference',
          callback: safeRawResponse(payload)
        }
      };
    }

    try {
      const verification = await this.verifyPayment({
        providerReference: tranId ?? sessionKey ?? valId ?? providerEventId,
        providerSessionId: sessionKey,
        providerTransactionId: valId,
        credentials: input.credentials
      });

      const callbackStatus = payloadString(payload, 'status')?.toLowerCase() ?? '';
      const mappedStatus =
        verification.status === 'SUCCESS'
          ? 'SUCCESS'
          : ['failed'].includes(callbackStatus)
            ? 'FAILED'
            : ['cancelled', 'canceled'].includes(callbackStatus)
              ? 'CANCELLED'
              : verification.status === 'FAILED'
                ? 'FAILED'
                : 'PENDING';

      return {
        isVerified: verification.status !== 'PENDING',
        providerEventId,
        merchantOrderId: tranId,
        providerReference: verification.providerReference,
        providerSessionId: verification.providerSessionId ?? sessionKey,
        status: mappedStatus,
        payload: {
          provider: 'SSLCOMMERZ',
          verified: verification.status !== 'PENDING',
          callbackStatus: callbackStatus || null,
          callback: safeRawResponse(payload),
          verification: verification.rawResponse
        }
      };
    } catch (error) {
      return {
        isVerified: false,
        providerEventId,
        merchantOrderId: tranId,
        providerReference: tranId,
        providerSessionId: sessionKey,
        status: 'PENDING',
        payload: {
          provider: 'SSLCOMMERZ',
          verified: false,
          callback: safeRawResponse(payload),
          error: error instanceof Error ? error.message : 'validation_failed'
        }
      };
    }
  }

  async refundPayment(_input: ProviderRefundPaymentInput): Promise<ProviderRefundPaymentResult> {
    throw new ApiError(501, 'PROVIDER_ERROR', 'SSLCOMMERZ refund API is not implemented yet');
  }
}
