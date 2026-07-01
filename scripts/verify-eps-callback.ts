import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ProviderName } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { encryptValue } from '../src/utils/encrypt.js';
import { signHmacSha256, stableJsonStringify } from '../src/utils/hmac.js';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const ADMIN_EMAIL = process.env.VERIFY_ADMIN_EMAIL ?? 'admin@worldpetsassociation.com';
const ADMIN_PASSWORD = process.env.VERIFY_ADMIN_PASSWORD ?? 'WpaAdmin123!';
const MERCHANT_CALLBACK_ORIGIN = 'http://127.0.0.1:3101';
const EPS_STUB_BASE = 'http://127.0.0.1:4011';
const EPS_PASSWORD = 'eps-local-password';
const EPS_HASH_KEY = 'eps-local-hash-key-base64-sample';

type JsonObject = Record<string, unknown>;

const normalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }

  return value;
};

const stableJson = (value: unknown) => JSON.stringify(normalizeJson(value));
const safeStringify = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry));
const sha256Hex = (payload: string) => createHash('sha256').update(payload).digest('hex');
const canonical = (method: string, path: string, timestamp: string, body: string) =>
  `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256Hex(body)}`;

const signMerchantRequest = (secret: string, body: JsonObject, timestamp: string, nonce: string) =>
  createHmac('sha256', secret)
    .update(canonical('POST', '/api/v1/payment-sessions', timestamp, stableJson({ ...body, timestamp, nonce })))
    .digest('hex');

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${API_BASE}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body };
};

const requestText = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${API_BASE}${path}`, init);
  const body = await response.text();
  return { response, body };
};

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const adminLogin = async () => {
  const { response, body } = await requestJson('/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  assert(response.ok, `Admin login failed: ${JSON.stringify(body)}`);
  return (body as { token: string }).token;
};

const adminRequest = async (token: string, path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return requestJson(path, {
    ...init,
    headers
  });
};

const createFixture = async (token: string, suffix: string) => {
  const merchantEmail = `eps-callback-${suffix}-${Date.now()}@example.com`;
  const { response: merchantRes, body: merchantBody } = await adminRequest(token, '/api/v1/admin/merchants', {
    method: 'POST',
    body: JSON.stringify({
      name: `EPS Callback Merchant ${suffix}`,
      business_name: `EPS Callback Merchant ${suffix} LLC`,
      contact_email: merchantEmail,
      contact_phone: '+8801712345678',
      status: 'ACTIVE',
      environment: 'SANDBOX',
      notes: 'EPS callback verification merchant'
    })
  });
  assert(merchantRes.ok, `Merchant create failed: ${JSON.stringify(merchantBody)}`);
  const merchant = merchantBody as { id: string };

  const domainPayload = {
    origin: MERCHANT_CALLBACK_ORIGIN,
    callback_url: `${MERCHANT_CALLBACK_ORIGIN}/callback`,
    webhook_url: `${MERCHANT_CALLBACK_ORIGIN}/webhook`,
    status: 'ACTIVE',
    environment: 'SANDBOX'
  };
  const { response: domainRes, body: domainBody } = await adminRequest(token, `/api/v1/admin/merchants/${merchant.id}/domains`, {
    method: 'POST',
    body: JSON.stringify(domainPayload)
  });
  assert(domainRes.ok, `Domain create failed: ${JSON.stringify(domainBody)}`);

  const { response: keyRes, body: keyBody } = await adminRequest(token, `/api/v1/admin/merchants/${merchant.id}/api-keys`, {
    method: 'POST',
    body: JSON.stringify({
      label: `eps-callback-${suffix}`,
      environment: 'SANDBOX'
    })
  });
  assert(keyRes.status === 201, `API key create failed: ${JSON.stringify(keyBody)}`);
  const key = keyBody as { credentials: { client_id: string; client_secret: string } };

  return {
    merchantId: merchant.id,
    clientId: key.credentials.client_id,
    clientSecret: key.credentials.client_secret
  };
};

const ensureEpsProvider = async () => {
  const provider = await prisma.paymentProvider.upsert({
    where: { name: ProviderName.EPS },
    update: {
      displayName: 'EPS Sandbox',
      isActive: true,
      supportedCurrencies: ['BDT'],
      supportedCountries: ['BD']
    },
    create: {
      name: ProviderName.EPS,
      displayName: 'EPS Sandbox',
      isActive: true,
      supportedCurrencies: ['BDT'],
      supportedCountries: ['BD'],
      priority: 1
    }
  });

  return provider;
};

const configureEpsCredentials = async (providerId: string) => {
  await prisma.providerCredential.updateMany({
    where: { providerId, merchantId: null },
    data: { isActive: false }
  });

  const credentialEntries = {
    username: 'sandbox-user@example.com',
    password: EPS_PASSWORD,
    hashKey: EPS_HASH_KEY,
    merchantId: '11111111-2222-3333-4444-555555555555',
    storeId: '66666666-7777-8888-9999-000000000000',
    baseUrl: EPS_STUB_BASE,
    sandbox: 'true'
  };

  for (const [keyLabel, value] of Object.entries(credentialEntries)) {
    const encrypted = encryptValue(value, env.CREDENTIAL_ENCRYPTION_KEY);
    const existing = await prisma.providerCredential.findFirst({
      where: {
        providerId,
        merchantId: null,
        keyLabel
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    if (existing) {
      await prisma.providerCredential.update({
        where: { id: existing.id },
        data: {
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          isActive: true
        }
      });
    } else {
      await prisma.providerCredential.create({
        data: {
          providerId,
          merchantId: null,
          scope: 'PLATFORM',
          keyLabel,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          isActive: true
        }
      });
    }
  }
};

const ensureMerchantProviderSetting = async (merchantId: string, providerId: string) => {
  await prisma.merchantProviderSetting.upsert({
    where: {
      merchantId_providerId: {
        merchantId,
        providerId
      }
    },
    update: {
      isEnabled: true,
      priority: 1,
      currencies: ['BDT'],
      countries: ['BD']
    },
    create: {
      merchantId,
      providerId,
      isEnabled: true,
      priority: 1,
      currencies: ['BDT'],
      countries: ['BD']
    }
  });
};

const createPaymentSession = async (
  fixture: { clientId: string; clientSecret: string },
  merchantOrderId: string,
  callbackOverrides?: { callbackUrl?: string; webhookUrl?: string }
) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(12).toString('hex');
  const payload = {
    clientId: fixture.clientId,
    merchantOrderId,
    amount: 1500,
    currency: 'BDT',
    customerName: 'EPS Callback Customer',
    customerEmail: 'customer@example.com',
    customerPhone: '+8801712345678',
    description: 'EPS callback verification order',
    successUrl: `${MERCHANT_CALLBACK_ORIGIN}/merchant/success`,
    callbackUrl: callbackOverrides?.callbackUrl ?? `${MERCHANT_CALLBACK_ORIGIN}/callback`,
    cancelUrl: `${MERCHANT_CALLBACK_ORIGIN}/merchant/cancel`,
    webhookUrl: callbackOverrides?.webhookUrl ?? `${MERCHANT_CALLBACK_ORIGIN}/webhook`,
    metadata: { source: 'eps-callback-verifier' }
  };

  const signature = signMerchantRequest(fixture.clientSecret, payload, timestamp, nonce);
  const { response, body } = await requestJson('/api/v1/payment-sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: MERCHANT_CALLBACK_ORIGIN
    },
    body: JSON.stringify({
      ...payload,
      timestamp,
      nonce,
      signature
    })
  });

  assert(response.status === 201, `Payment session create failed: ${JSON.stringify(body)}`);
  return body as { session: { id: string; reference: string } };
};

const prepareSession = async (input: {
  merchantId: string;
  providerId: string;
  reference: string;
  merchantTransactionId: string;
  epsTransactionId: string;
  returnUrl?: string;
}) => {
  const session = await prisma.paymentSession.findUniqueOrThrow({
    where: { reference: input.reference },
    include: {
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  await prisma.paymentSession.update({
    where: { id: session.id },
    data: {
      providerId: input.providerId,
      providerReference: input.merchantTransactionId,
      providerSessionId: input.epsTransactionId,
      returnUrl: input.returnUrl ?? `${MERCHANT_CALLBACK_ORIGIN}/checkout/${input.reference}`
    }
  });

  if (session.transactions[0]) {
    await prisma.transaction.update({
      where: { id: session.transactions[0].id },
      data: {
        providerId: input.providerId,
        providerReference: input.merchantTransactionId,
        status: 'PENDING'
      }
    });
  }
};

const initiateCheckoutPayment = async (reference: string, providerCode = 'EPS') => {
  const { response, body } = await requestJson(`/api/v1/checkout/${reference}/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ providerCode })
  });

  return { response, body };
};

type VerificationState = {
  [merchantTransactionId: string]: {
    status: 'Success' | 'Failed' | 'Pending' | 'Error';
    epsTransactionId: string;
  };
};

const verificationState: VerificationState = {};
const callbackEvents: Array<{
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> = [];

const readBody = async (request: import('node:http').IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
};

const startServers = async () => {
  const epsServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', EPS_STUB_BASE);
    if (url.pathname === '/v1/Auth/GetToken' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'eps-stub-token', expireDate: new Date(Date.now() + 60_000).toISOString() }));
      return;
    }

    if (url.pathname === '/v1/EPSEngine/InitializeEPS' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const parsedBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      const merchantTransactionId =
        typeof parsedBody.merchantTransactionId === 'string'
          ? parsedBody.merchantTransactionId
          : `mtx_stub_${randomBytes(6).toString('hex')}`;

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          TransactionId: `eps_init_${merchantTransactionId}`,
          RedirectURL: `${EPS_STUB_BASE}/redirect/${merchantTransactionId}`
        })
      );
      return;
    }

    if (url.pathname === '/v1/EPSEngine/CheckMerchantTransactionStatus' && req.method === 'GET') {
      const merchantTransactionId = url.searchParams.get('merchantTransactionId') ?? 'unknown';
      const epsTransactionId = url.searchParams.get('EPSTransactionId') ?? undefined;
      const state = verificationState[merchantTransactionId] ?? (epsTransactionId ? verificationState[epsTransactionId] : undefined);

      if (!state || state.status === 'Error') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ErrorCode: 'VERIFY_ERROR', ErrorMessage: 'verification failed' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          MerchantTransactionId: merchantTransactionId,
          EpsTransactionId: state.epsTransactionId,
          Status: state.status
        })
      );
      return;
    }

    res.writeHead(404).end();
  });

  const merchantServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', MERCHANT_CALLBACK_ORIGIN);
    const body = await readBody(req);
    callbackEvents.push({
      headers: req.headers,
      body: body ? JSON.parse(body) : null
    });

    if (url.pathname === '/webhook-fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  epsServer.listen(4011, '127.0.0.1');
  merchantServer.listen(3101, '127.0.0.1');
  await Promise.all([once(epsServer, 'listening'), once(merchantServer, 'listening')]);

  return { epsServer, merchantServer };
};

const main = async () => {
  const { epsServer, merchantServer } = await startServers();
  const runId = `${Date.now()}_${randomBytes(4).toString('hex')}`;

  try {
    const token = await adminLogin();
    const provider = await ensureEpsProvider();
    await configureEpsCredentials(provider.id);

    const fixture = await createFixture(token, 'main');
    await ensureMerchantProviderSetting(fixture.merchantId, provider.id);

    const pending = await createPaymentSession(fixture, `pending_${Date.now()}`);
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: pending.session.reference,
      merchantTransactionId: `mtx_pending_${runId}`,
      epsTransactionId: `eps_pending_${runId}`
    });
    verificationState[`mtx_pending_${runId}`] = { status: 'Pending', epsTransactionId: `eps_pending_${runId}` };

    const pendingReturn = await fetch(`${API_BASE}/api/v1/providers/eps/success?merchantTransactionId=mtx_pending_${runId}`, { redirect: 'manual' });
    assert(pendingReturn.status === 302 || pendingReturn.status === 200, 'Expected safe return handling for pending success URL');
    const pendingSession = await prisma.paymentSession.findUniqueOrThrow({ where: { reference: pending.session.reference } });
    assert(pendingSession.status === 'PENDING', 'Frontend success return alone must not mark success');

    const publicCheckoutResponse = await fetch(`${API_BASE}/api/v1/checkout/${pending.session.reference}`);
    assert(publicCheckoutResponse.ok, 'Public checkout read should succeed for valid session');
    const publicCheckoutBody = (await publicCheckoutResponse.json()) as { session?: Record<string, unknown> };
    const publicSession = publicCheckoutBody.session ?? {};
    assert(!('id' in publicSession), 'Public checkout response must not expose internal session id');
    assert(!('merchantId' in publicSession), 'Public checkout response must not expose merchant id');
    assert(!('providerReference' in publicSession), 'Public checkout response must not expose provider reference');
    assert(!('requestHash' in publicSession), 'Public checkout response must not expose request hash');

    const unknownResponse = await fetch(`${API_BASE}/api/v1/providers/eps/success?merchantTransactionId=mtx_unknown_${runId}`, { redirect: 'manual' });
    assert(unknownResponse.status === 404 || unknownResponse.status === 400, 'Unknown callback should be rejected safely');
    const unknownLog = await prisma.webhookLog.findFirst({
      where: {
        rawPayload: {
          path: ['callback', 'merchantTransactionId'],
          equals: `mtx_unknown_${runId}`
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    assert(unknownLog, 'Unknown callback should be logged');

    const invalid = await createPaymentSession(fixture, `invalid_${Date.now()}`);
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: invalid.session.reference,
      merchantTransactionId: `mtx_invalid_${runId}`,
      epsTransactionId: `eps_invalid_${runId}`
    });
    verificationState[`mtx_invalid_${runId}`] = { status: 'Error', epsTransactionId: `eps_invalid_${runId}` };

    const invalidResponse = await fetch(`${API_BASE}/api/v1/providers/eps/callback?merchantTransactionId=mtx_invalid_${runId}`, { redirect: 'manual' });
    assert(invalidResponse.status === 400, 'Invalid callback should fail verification');
    const invalidSession = await prisma.paymentSession.findUniqueOrThrow({ where: { reference: invalid.session.reference } });
    assert(invalidSession.status === 'PENDING', 'Invalid callback must not mark session success');

    const invalidContentType = await requestText(`/api/v1/providers/eps/callback`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain'
      },
      body: `merchantTransactionId=mtx_invalid_${runId}`
    });
    assert(
      invalidContentType.response.status === 415 || invalidContentType.response.status === 400,
      'Invalid callback content type should fail safely'
    );

    const success = await createPaymentSession(fixture, `success_${Date.now()}`);
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: success.session.reference,
      merchantTransactionId: `mtx_success_${runId}`,
      epsTransactionId: `eps_success_${runId}`
    });
    verificationState[`mtx_success_${runId}`] = { status: 'Success', epsTransactionId: `eps_success_${runId}` };

    const successResponse = await fetch(`${API_BASE}/api/v1/providers/eps/success?merchantTransactionId=mtx_success_${runId}`, { redirect: 'manual' });
    assert(successResponse.status === 302 || successResponse.status === 200, 'Verified success callback should be accepted');

    const successSession = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: success.session.reference },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        },
        callbackLogs: true
      }
    });
    assert(successSession.status === 'SUCCESS', 'Verified success must mark session success');
    assert(successSession.transactions[0]?.status === 'SUCCESS', 'Verified success must mark transaction success');
    assert(successSession.callbackLogs.length === 1, 'Verified success should create one callback log');

    const callbackEvent = callbackEvents.at(-1);
    assert(callbackEvent, 'Merchant callback should be delivered');
    const callbackPayload = callbackEvent!.body as Record<string, unknown>;
    assert(callbackPayload.event === 'payment.succeeded', 'Merchant callback event should be payment.succeeded');
    const signature = callbackEvent!.headers['x-gateway-signature'];
    assert(typeof signature === 'string', 'Merchant callback signature missing');
    assert(
      signHmacSha256(stableJsonStringify(callbackPayload), fixture.clientSecret) === signature,
      'Merchant callback signature mismatch'
    );

    const duplicateResponse = await fetch(`${API_BASE}/api/v1/providers/eps/success?merchantTransactionId=mtx_success_${runId}`, { redirect: 'manual' });
    assert(duplicateResponse.status === 302 || duplicateResponse.status === 200, 'Duplicate success callback should be idempotent');
    const callbackLogCount = await prisma.callbackLog.count({
      where: { sessionId: successSession.id }
    });
    assert(callbackLogCount === 1, 'Duplicate success callback must not redeliver merchant callback');

    verificationState[`mtx_success_${runId}`] = { status: 'Failed', epsTransactionId: `eps_success_${runId}` };
    const downgradeResponse = await requestJson('/api/v1/providers/eps/fail', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        merchantTransactionId: `mtx_success_${runId}`,
        EPSTransactionId: `eps_success_${runId}`
      })
    });
    assert(
      downgradeResponse.response.status === 200 || downgradeResponse.response.status === 302,
      'Downgrade attempt should be handled safely'
    );
    const successAfterDowngrade = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: success.session.reference },
      include: { callbackLogs: true, transactions: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    assert(successAfterDowngrade.status === 'SUCCESS', 'Success must not be downgraded by later fail callback');
    assert(successAfterDowngrade.transactions[0]?.status === 'SUCCESS', 'Transaction success must not be downgraded by later fail callback');
    assert(successAfterDowngrade.callbackLogs.length === 1, 'Downgrade attempt must not redeliver merchant callback');

    const failed = await createPaymentSession(fixture, `failed_${Date.now()}`);
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: failed.session.reference,
      merchantTransactionId: `mtx_failed_${runId}`,
      epsTransactionId: `eps_failed_${runId}`
    });
    verificationState[`mtx_failed_${runId}`] = { status: 'Failed', epsTransactionId: `eps_failed_${runId}` };
    const failResponse = await requestJson('/api/v1/providers/eps/fail', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        merchantTransactionId: `mtx_failed_${runId}`,
        EPSTransactionId: `eps_failed_${runId}`
      })
    });
    assert(
      failResponse.response.status === 302 || failResponse.response.status === 200,
      'Verified fail callback should be accepted'
    );
    const failedSession = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: failed.session.reference },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    assert(failedSession.status === 'FAILED', 'Verified fail callback must mark session failed');
    assert(failedSession.transactions[0]?.status === 'FAILED', 'Verified fail callback must mark transaction failed');

    const formSuccess = await createPaymentSession(fixture, `form_${Date.now()}`);
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: formSuccess.session.reference,
      merchantTransactionId: `mtx_form_${runId}`,
      epsTransactionId: `eps_form_${runId}`
    });
    verificationState[`mtx_form_${runId}`] = { status: 'Success', epsTransactionId: `eps_form_${runId}` };
    const formResponse = await fetch(`${API_BASE}/api/v1/providers/eps/success`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        merchantTransactionId: `mtx_form_${runId}`,
        EPSTransactionId: `eps_form_${runId}`
      })
    });
    assert(formResponse.status === 200, 'Form-encoded EPS callback should be accepted');
    const formSession = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: formSuccess.session.reference },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    assert(formSession.status === 'SUCCESS', 'Form-encoded verified success must mark session success');
    assert(formSession.transactions[0]?.status === 'SUCCESS', 'Form-encoded verified success must mark transaction success');

    const cancelled = await createPaymentSession(fixture, `cancel_${Date.now()}`);
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: cancelled.session.reference,
      merchantTransactionId: `mtx_cancel_${runId}`,
      epsTransactionId: `eps_cancel_${runId}`
    });
    verificationState[`mtx_cancel_${runId}`] = { status: 'Pending', epsTransactionId: `eps_cancel_${runId}` };
    const cancelResponse = await fetch(`${API_BASE}/api/v1/providers/eps/cancel?merchantTransactionId=mtx_cancel_${runId}`, { redirect: 'manual' });
    assert(cancelResponse.status === 302 || cancelResponse.status === 200, 'Cancel callback should be accepted safely');
    const cancelledSession = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: cancelled.session.reference },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    assert(cancelledSession.status === 'CANCELLED', 'Cancel callback must mark session cancelled');
    assert(cancelledSession.transactions[0]?.status === 'CANCELLED', 'Cancel callback must mark transaction cancelled');

    const callbackFail = await createPaymentSession(fixture, `callbackfail_${Date.now()}`, {
      callbackUrl: `${MERCHANT_CALLBACK_ORIGIN}/callback`,
      webhookUrl: `${MERCHANT_CALLBACK_ORIGIN}/webhook-fail`
    });
    await prepareSession({
      merchantId: fixture.merchantId,
      providerId: provider.id,
      reference: callbackFail.session.reference,
      merchantTransactionId: `mtx_callback_fail_${runId}`,
      epsTransactionId: `eps_callback_fail_${runId}`
    });
    verificationState[`mtx_callback_fail_${runId}`] = { status: 'Success', epsTransactionId: `eps_callback_fail_${runId}` };
    const callbackFailResponse = await fetch(`${API_BASE}/api/v1/providers/eps/success?merchantTransactionId=mtx_callback_fail_${runId}`, { redirect: 'manual' });
    assert(callbackFailResponse.status === 302 || callbackFailResponse.status === 200, 'Success callback with merchant webhook failure should still complete');
    const callbackFailSession = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: callbackFail.session.reference },
      include: { callbackLogs: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    assert(callbackFailSession.status === 'SUCCESS', 'Merchant webhook failure must not rollback verified payment');
    assert(callbackFailSession.callbackLogs[0]?.status === 'FAILED', 'Merchant webhook failure should be logged');

    const initiate = await createPaymentSession(fixture, `initiate_${Date.now()}`);
    const initiateResult = await initiateCheckoutPayment(initiate.session.reference);
    assert(initiateResult.response.status === 200, `Checkout pay should initiate EPS: ${JSON.stringify(initiateResult.body)}`);
    const initiatedTransaction = await prisma.transaction.findFirstOrThrow({
      where: { session: { reference: initiate.session.reference } },
      orderBy: { createdAt: 'desc' }
    });
    const initiatedRawResponse = initiatedTransaction.rawResponse as Record<string, unknown>;
    const initiatedRequest = initiatedRawResponse.request as Record<string, unknown> | undefined;
    assert(typeof initiatedRequest?.successUrl === 'string', 'EPS initiate should store sanitized provider success URL');
    assert(typeof initiatedRequest?.failUrl === 'string', 'EPS initiate should store sanitized provider fail URL');
    assert(typeof initiatedRequest?.cancelUrl === 'string', 'EPS initiate should store sanitized provider cancel URL');
    if (env.PUBLIC_GATEWAY_URL) {
      assert(
        (initiatedRequest?.successUrl as string).startsWith(env.PUBLIC_GATEWAY_URL),
        'Generated provider success URL should use PUBLIC_GATEWAY_URL when configured'
      );
      assert(
        (initiatedRequest?.failUrl as string).startsWith(env.PUBLIC_GATEWAY_URL),
        'Generated provider fail URL should use PUBLIC_GATEWAY_URL when configured'
      );
      assert(
        (initiatedRequest?.cancelUrl as string).startsWith(env.PUBLIC_GATEWAY_URL),
        'Generated provider cancel URL should use PUBLIC_GATEWAY_URL when configured'
      );
    }
    const initiatePublicResponse = await fetch(`${API_BASE}/api/v1/checkout/${initiate.session.reference}`);
    const initiatePublicBody = (await initiatePublicResponse.json()) as { session?: Record<string, unknown> };
    assert(!safeStringify(initiatePublicBody).includes('requestHash'), 'Public checkout response must not expose request hash');
    assert(!safeStringify(initiatePublicBody).includes(EPS_PASSWORD), 'Public checkout response must not expose provider credentials');

    const leakedLog = await prisma.transaction.findFirst({
      where: { session: { reference: success.session.reference } },
      orderBy: { createdAt: 'desc' }
    });
    const combinedArtifacts = safeStringify({
      webhookLogs: await prisma.webhookLog.findMany({ take: 20, orderBy: { createdAt: 'desc' } }),
      callbackLogs: await prisma.callbackLog.findMany({ take: 20, orderBy: { createdAt: 'desc' } }),
      transaction: leakedLog
    });
    assert(!combinedArtifacts.includes(EPS_PASSWORD), 'Logs should not contain raw EPS password');
    assert(!combinedArtifacts.includes('eps-stub-token'), 'Logs should not contain EPS auth token');

    console.log('ALL PASS');
  } finally {
    await prisma.$disconnect();
    epsServer.close();
    merchantServer.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
