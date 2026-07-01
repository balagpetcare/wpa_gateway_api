import { createHmac, randomBytes } from 'node:crypto';
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

type EPSConfig = {
  username: string;
  password: string;
  hashKey: string;
  merchantId: string;
  storeId: string;
  baseUrl: string;
  timeoutMs: number;
  sandbox: boolean;
};

const DEFAULT_ENDPOINTS = {
  SANDBOX: 'https://sandbox-pgapi.eps.com.bd',
  PRODUCTION: 'https://pgapi.eps.com.bd'
} as const;

const EPS_PATHS = {
  GET_TOKEN: '/v1/Auth/GetToken',
  INITIALIZE: '/v1/EPSEngine/InitializeEPS',
  VERIFY: '/v1/EPSEngine/CheckMerchantTransactionStatus'
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

const generateMerchantTransactionId = () => {
  const now = new Date();
  const parts = [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    String(now.getMilliseconds()).padStart(3, '0')
  ];

  return parts.join('');
};

const generateHash = (value: string, hashKey: string) => createHmac('sha512', Buffer.from(hashKey, 'utf8')).update(value, 'utf8').digest('base64');

const safeJsonCopy = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
};

const readPayloadString = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const parseWebhookPayload = (rawBody: string) => {
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

const normalizeBangladeshPhone = (value?: string) => {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) {
    return `0${digits.slice(3)}`;
  }

  if (digits.length === 11 && digits.startsWith('01')) {
    return digits;
  }

  return null;
};

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const readConfig = (credentials: Record<string, string>): EPSConfig => {
  const username = readCredential(credentials, 'username', 'userName');
  const password = readCredential(credentials, 'password');
  const hashKey = readCredential(credentials, 'hashKey', 'hash_key', 'hash-key', 'secret', 'apiKey', 'api_key');
  const merchantId = readCredential(credentials, 'merchantId', 'merchant_id');
  const storeId = readCredential(credentials, 'storeId', 'store_id');
  const configuredBaseUrl = readCredential(credentials, 'baseUrl', 'base_url');
  const sandbox = parseBoolean(readCredential(credentials, 'sandbox')) ?? true;
  const timeoutMs = parseTimeout(readCredential(credentials, 'timeoutMs', 'timeout_ms'));

  if (!username || !password || !hashKey || !merchantId || !storeId) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'EPS provider credentials are not configured');
  }

  const baseUrl =
    configuredBaseUrl && configuredBaseUrl.length > 0
      ? configuredBaseUrl
      : sandbox
        ? DEFAULT_ENDPOINTS.SANDBOX
        : DEFAULT_ENDPOINTS.PRODUCTION;

  return {
    username,
    password,
    hashKey,
    merchantId,
    storeId,
    baseUrl: normalizeBaseUrl(baseUrl),
    timeoutMs,
    sandbox
  };
};

const buildEndpoints = (config: EPSConfig) => ({
  GET_TOKEN: `${config.baseUrl}${EPS_PATHS.GET_TOKEN}`,
  INITIALIZE: `${config.baseUrl}${EPS_PATHS.INITIALIZE}`,
  VERIFY: `${config.baseUrl}${EPS_PATHS.VERIFY}`
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
      throw new ApiError(504, 'PROVIDER_TIMEOUT', 'EPS request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const buildCustomerDefaults = (input: ProviderCreatePaymentInput) => {
  const email = input.customer.email.trim();
  const phone = normalizeBangladeshPhone(input.customer.phone);

  if (!isValidEmail(email)) {
    throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'EPS requires a valid customer email address');
  }

  if (!phone) {
    throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'EPS requires a valid Bangladesh customer phone number');
  }

  return {
    customerEmail: email,
    customerPhone: phone,
    customerAddress: input.purpose?.trim() || `Payment for ${input.orderId}`,
    customerCity: 'Dhaka',
    customerState: 'Dhaka',
    customerPostcode: '1200',
    customerCountry: 'BD',
    productName: input.purpose?.trim() || `WPA payment ${input.orderId}`
  };
};

const getAuthToken = async (config: EPSConfig, endpoints: ReturnType<typeof buildEndpoints>) => {
  const tokenResponse = await requestJson<{
    token?: string;
    expireDate?: string;
    errorMessage?: string;
    errorCode?: string;
  }>({
    url: endpoints.GET_TOKEN,
    method: 'POST',
    timeoutMs: config.timeoutMs,
    headers: {
      'x-hash': generateHash(config.username, config.hashKey)
    },
    body: {
      userName: config.username,
      password: config.password
    }
  });

  if (!tokenResponse.ok || tokenResponse.data.errorMessage || tokenResponse.data.errorCode || !tokenResponse.data.token) {
    throwProviderInitiationError(tokenResponse.data.errorMessage || 'EPS authentication failed', 'PROVIDER_UNAVAILABLE');
  }

  return tokenResponse.data.token;
};

const buildSafeResponse = (payload: {
  providerReference: string;
  providerSessionId: string;
  paymentUrl?: string;
  rawResponse: Record<string, unknown>;
}) => ({
  providerReference: payload.providerReference,
  providerSessionId: payload.providerSessionId,
  paymentUrl: payload.paymentUrl ?? null,
  rawResponse: payload.rawResponse
});

const throwProviderInitiationError = (
  message: string,
  code: 'PROVIDER_INIT_FAILED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR' = 'PROVIDER_INIT_FAILED'
): never => {
  throw new ApiError(code === 'PROVIDER_UNAVAILABLE' ? 503 : 422, code, message);
};

export class EPSProviderAdapter implements PaymentProviderAdapter {
  async createPayment(input: ProviderCreatePaymentInput): Promise<ProviderCreatePaymentResult> {
    const config = readConfig(input.credentials);
    const endpoints = buildEndpoints(config);
    const merchantTransactionId = generateMerchantTransactionId();
    const customer = buildCustomerDefaults(input);
    const callbackUrl = input.callbackUrl || input.successUrl;
    const failUrl = input.cancelUrl || input.successUrl;
    const successUrl = input.successUrl;
    const hash = generateHash(merchantTransactionId, config.hashKey);

    const token = await getAuthToken(config, endpoints).catch((error: unknown) => {
      if (error instanceof ApiError) {
        throw error;
      }

      throwProviderInitiationError(error instanceof Error ? error.message : 'EPS authentication failed', 'PROVIDER_UNAVAILABLE');
    });

    try {
      const requestBody = {
        merchantId: config.merchantId,
        storeId: config.storeId,
        CustomerOrderId: input.orderId,
        merchantTransactionId,
        transactionTypeId: 1,
        financialEntityId: 0,
        transitionStatusId: 0,
        totalAmount: input.amountDecimal,
        ipAddress: '0.0.0.0',
        version: '1',
        successUrl,
        failUrl,
        cancelUrl: callbackUrl,
        customerName: input.customer.name.trim(),
        customerEmail: customer.customerEmail,
        CustomerAddress: customer.customerAddress,
        CustomerAddress2: '',
        CustomerCity: customer.customerCity,
        CustomerState: customer.customerState,
        CustomerPostcode: customer.customerPostcode,
        CustomerCountry: customer.customerCountry,
        CustomerPhone: customer.customerPhone,
        ShipmentName: input.customer.name.trim(),
        ShipmentAddress: '',
        ShipmentAddress2: '',
        ShipmentCity: '',
        ShipmentState: '',
        ShipmentPostcode: '',
        ShipmentCountry: '',
        ValueA: input.orderId,
        ValueB: input.sessionId,
        ValueC: input.merchantId,
        ValueD: input.currency,
        ShippingMethod: 'NO',
        NoOfItem: '1',
        ProductName: customer.productName,
        ProductProfile: 'general',
        ProductCategory: 'general',
        ProductList: []
      };

      const initResponse = await requestJson<{
        TransactionId?: string;
        RedirectURL?: string;
        ErrorMessage?: string;
        ErrorCode?: string;
      }>({
        url: endpoints.INITIALIZE,
        method: 'POST',
        timeoutMs: config.timeoutMs,
        headers: {
          'x-hash': hash,
          Authorization: `Bearer ${token}`
        },
        body: requestBody
      });

      if (!initResponse.ok || initResponse.data.ErrorMessage || initResponse.data.ErrorCode) {
        const errorCode = initResponse.data.ErrorCode?.toUpperCase() ?? 'INIT_ERROR';
        const statusCode =
          errorCode.includes('TIMEOUT') || errorCode.includes('NETWORK') ? 503 : 422;

        throw new ApiError(statusCode, statusCode === 503 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_INIT_FAILED', initResponse.data.ErrorMessage || 'EPS payment initiation failed');
      }

      const providerSessionId = initResponse.data.TransactionId || merchantTransactionId;
      const redirectUrl = initResponse.data.RedirectURL;
      if (!redirectUrl || typeof redirectUrl !== 'string') {
        throwProviderInitiationError('EPS did not return a redirect URL');
      }

      const safeResponse = buildSafeResponse({
        providerReference: merchantTransactionId,
        providerSessionId,
        paymentUrl: redirectUrl,
        rawResponse: {
          provider: 'EPS',
          sandbox: config.sandbox,
          paymentUrl: redirectUrl,
          request: {
            customerOrderId: input.orderId,
            merchantTransactionId,
            amount: input.amount,
            currency: input.currency,
            successUrl,
            failUrl,
            cancelUrl: callbackUrl
          },
          response: {
            transactionId: providerSessionId,
            redirectUrl
          }
        }
      });

      return {
        providerSessionId,
        providerReference: merchantTransactionId,
        rawResponse: safeResponse.rawResponse
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throwProviderInitiationError(error instanceof Error ? error.message : 'EPS payment initiation failed');
    }

    throw new ApiError(502, 'PROVIDER_ERROR', 'EPS payment initiation failed');
  }

  async verifyPayment(input: ProviderVerifyPaymentInput): Promise<ProviderVerifyPaymentResult> {
    const config = readConfig(input.credentials);
    const endpoints = buildEndpoints(config);
    const merchantTransactionId = input.merchantTransactionId ?? input.providerReference;
    const epsTransactionId = input.providerTransactionId ?? input.providerSessionId;
    const transactionHashValue = merchantTransactionId || epsTransactionId || input.providerReference;

    if (!transactionHashValue) {
      throw new ApiError(422, 'PROVIDER_INIT_FAILED', 'EPS verification requires a merchant transaction reference');
    }

    const token = await getAuthToken(config, endpoints);

    const query = new URLSearchParams();
    if (merchantTransactionId) {
      query.set('merchantTransactionId', merchantTransactionId);
    } else if (epsTransactionId) {
      query.set('EPSTransactionId', epsTransactionId);
    }

    const verificationUrl = `${endpoints.VERIFY}?${query.toString()}`;
    const verification = await requestJson<{
      MerchantTransactionId?: string;
      EpsTransactionId?: string;
      Status?: string;
      ErrorMessage?: string;
      ErrorCode?: string;
    }>({
      url: verificationUrl,
      method: 'GET',
      timeoutMs: config.timeoutMs,
      headers: {
        'x-hash': generateHash(transactionHashValue, config.hashKey),
        Authorization: `Bearer ${token}`
      }
    });

    if (!verification.ok || verification.data.ErrorMessage || verification.data.ErrorCode) {
      throw new ApiError(422, 'PROVIDER_INIT_FAILED', verification.data.ErrorMessage || 'EPS verification failed');
    }

    const status = (verification.data.Status || 'Pending').toLowerCase();
    return {
      status: status === 'success' ? 'SUCCESS' : status === 'failed' ? 'FAILED' : 'PENDING',
      providerReference: verification.data.MerchantTransactionId || transactionHashValue,
      providerSessionId: verification.data.EpsTransactionId || epsTransactionId,
      rawResponse: {
        provider: 'EPS',
        verification: {
          merchantTransactionId: verification.data.MerchantTransactionId || transactionHashValue,
          epsTransactionId: verification.data.EpsTransactionId ?? null,
          status: verification.data.Status ?? 'Pending'
        }
      }
    };
  }

  async handleWebhook(input: ProviderHandleWebhookInput): Promise<ProviderHandleWebhookResult> {
    const payload = parseWebhookPayload(input.rawBody);
    const callbackType = typeof input.headers['x-provider-callback-type'] === 'string' ? input.headers['x-provider-callback-type'] : 'callback';
    const merchantTransactionId = readPayloadString(payload, 'merchantTransactionId', 'MerchantTransactionId');
    const epsTransactionId = readPayloadString(payload, 'epsTransactionId', 'EpsTransactionId', 'EPSTransactionId', 'TransactionId');
    const merchantOrderId = readPayloadString(payload, 'customerOrderId', 'CustomerOrderId', 'orderId', 'OrderId');

    const providerEventId =
      readPayloadString(payload, 'eventId', 'EventId') ||
      [callbackType, merchantTransactionId ?? 'unknown', epsTransactionId ?? 'none'].join(':');

    if (!merchantTransactionId && !epsTransactionId) {
      return {
        isVerified: false,
        providerEventId,
        merchantOrderId,
        status: 'PENDING',
        payload: {
          provider: 'EPS',
          callbackType,
          reason: 'missing_transaction_reference',
          callback: safeJsonCopy(payload)
        }
      };
    }

    try {
      const verification = await this.verifyPayment({
        providerReference: merchantTransactionId ?? epsTransactionId ?? '',
        providerSessionId: epsTransactionId,
        merchantTransactionId,
        providerTransactionId: epsTransactionId,
        credentials: input.credentials
      });

      const mappedStatus =
        verification.status === 'SUCCESS'
          ? 'SUCCESS'
          : callbackType === 'cancel'
            ? 'CANCELLED'
            : verification.status === 'FAILED'
              ? 'FAILED'
              : callbackType === 'fail'
                ? 'FAILED'
                : 'PENDING';

      return {
        isVerified: true,
        providerEventId,
        merchantOrderId,
        providerReference: verification.providerReference,
        providerSessionId: verification.providerSessionId ?? epsTransactionId,
        status: mappedStatus,
        payload: {
          provider: 'EPS',
          callbackType,
          verified: true,
          callback: safeJsonCopy(payload),
          verification: verification.rawResponse
        }
      };
    } catch (error) {
      return {
        isVerified: false,
        providerEventId,
        merchantOrderId,
        providerReference: merchantTransactionId,
        providerSessionId: epsTransactionId,
        status: 'PENDING',
        payload: {
          provider: 'EPS',
          callbackType,
          verified: false,
          reason: error instanceof Error ? error.message : 'verification_failed',
          callback: safeJsonCopy(payload)
        }
      };
    }
  }

  async refundPayment(_input: ProviderRefundPaymentInput): Promise<ProviderRefundPaymentResult> {
    throw new ApiError(501, 'PROVIDER_ERROR', 'EPS refund is not implemented yet');
  }
}
