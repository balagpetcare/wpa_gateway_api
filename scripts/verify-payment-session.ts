import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const ADMIN_EMAIL = process.env.VERIFY_ADMIN_EMAIL ?? 'admin@worldpetsassociation.com';
const ADMIN_PASSWORD = process.env.VERIFY_ADMIN_PASSWORD ?? 'WpaAdmin123!';
const ALLOWED_ORIGIN = process.env.VERIFY_ALLOWED_ORIGIN ?? 'http://localhost:3000';

type Json = Record<string, unknown>;

const stableJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => normalize(entry));
    }
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.keys(input as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = normalize((input as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return input;
  };

  return JSON.stringify(normalize(value));
};

const sha256Hex = (payload: string) => createHash('sha256').update(payload).digest('hex');

const canonicalPayload = (method: string, path: string, timestamp: string, body: string) =>
  `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256Hex(body)}`;

const signRequest = (secret: string, payload: Json, timestamp: string, nonce: string) => {
  const body = stableJson({
    ...payload,
    timestamp,
    nonce
  });
  return createHmac('sha256', secret).update(canonicalPayload('POST', '/api/v1/payment-sessions', timestamp, body)).digest('hex');
};

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

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const adminLogin = async () => {
  const { response, body } = await requestJson('/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      emailOrUsername: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    })
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

const createMerchantFixture = async (token: string, suffix: string) => {
  const email = `verify-${suffix}-${Date.now()}@example.com`;
  const merchantName = `Verify Merchant ${suffix}`;
  const { response: merchantRes, body: merchantBody } = await adminRequest(token, '/api/v1/admin/merchants', {
    method: 'POST',
    body: JSON.stringify({
      name: merchantName,
      business_name: `${merchantName} LLC`,
      contact_email: email,
      contact_phone: '+1 555 000 2000',
      status: 'ACTIVE',
      environment: 'SANDBOX',
      notes: 'Verification merchant'
    })
  });
  assert(merchantRes.ok, `Merchant create failed: ${JSON.stringify(merchantBody)}`);
  const merchant = merchantBody as { id: string };

  const { response: domainRes, body: domainBody } = await adminRequest(token, `/api/v1/admin/merchants/${merchant.id}/domains`, {
    method: 'POST',
    body: JSON.stringify({
      origin: ALLOWED_ORIGIN,
      callback_url: `${ALLOWED_ORIGIN}/callback`,
      webhook_url: `${ALLOWED_ORIGIN}/webhook`,
      status: 'ACTIVE',
      environment: 'SANDBOX'
    })
  });
  assert(domainRes.ok, `Domain create failed: ${JSON.stringify(domainBody)}`);

  const { response: keyRes, body: keyBody } = await adminRequest(token, `/api/v1/admin/merchants/${merchant.id}/api-keys`, {
    method: 'POST',
    body: JSON.stringify({
      label: `verify-${suffix}`,
      environment: 'SANDBOX'
    })
  });
  assert(keyRes.status === 201, `API key create failed: ${JSON.stringify(keyBody)}`);

  const key = keyBody as {
    key: { id: string };
    credentials: { client_id: string; client_secret: string };
  };

  return {
    merchantId: merchant.id,
    apiKeyId: key.key.id,
    clientId: key.credentials.client_id,
    clientSecret: key.credentials.client_secret
  };
};

const createPaymentSession = async (fixture: { clientId: string; clientSecret: string }, overrides?: Partial<Json>) => {
  const timestamp = overrides?.timestamp?.toString() ?? Math.floor(Date.now() / 1000).toString();
  const nonce = (overrides?.nonce as string | undefined) ?? randomBytes(12).toString('hex');
  const payload: Json = {
    clientId: fixture.clientId,
    merchantOrderId: overrides?.merchantOrderId ?? `order_${Date.now()}`,
    amount: overrides?.amount ?? 1299,
    currency: overrides?.currency ?? 'USD',
    customerName: overrides?.customerName ?? 'Verify Customer',
    customerEmail: overrides?.customerEmail ?? 'customer@example.com',
    customerPhone: overrides?.customerPhone ?? '+1 555 000 3000',
    description: overrides?.description ?? 'Verification payment',
    successUrl: overrides?.successUrl ?? `${ALLOWED_ORIGIN}/success`,
    callbackUrl: overrides?.callbackUrl ?? `${ALLOWED_ORIGIN}/callback`,
    cancelUrl: overrides?.cancelUrl ?? `${ALLOWED_ORIGIN}/cancel`,
    webhookUrl: overrides?.webhookUrl ?? `${ALLOWED_ORIGIN}/webhook`,
    metadata: overrides?.metadata ?? { source: 'verification-script' }
  };
  const signature = overrides?.signature?.toString() ?? signRequest(fixture.clientSecret, payload, timestamp, nonce);
  const { response, body } = await requestJson('/api/v1/payment-sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: overrides?.origin?.toString() ?? ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      ...payload,
      timestamp,
      nonce,
      signature
    })
  });
  return { response, body, payload: { ...payload, timestamp, nonce, signature } };
};

const expectFailure = async (label: string, run: () => Promise<{ response: Response; body: unknown }>, status: number) => {
  const { response, body } = await run();
  assert(response.status === status, `${label} expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  console.log(`PASS ${label}`);
};

const main = async () => {
  const adminToken = await adminLogin();

  const fixtureA = await createMerchantFixture(adminToken, 'a');
  const validA = await createPaymentSession(fixtureA);
  assert(validA.response.status === 201, `valid create failed: ${JSON.stringify(validA.body)}`);
  assert((validA.body as { success?: boolean }).success === true, 'valid create missing success true');
  const sessionA = (validA.body as { session: { id: string; reference: string; status: string } }).session;
  assert(sessionA.status === 'PENDING', `expected PENDING, got ${sessionA.status}`);
  console.log(`PASS valid create -> ${sessionA.reference}`);

  const idempotentA = await createPaymentSession(fixtureA, {
    merchantOrderId: validA.payload.merchantOrderId,
    amount: validA.payload.amount,
    currency: validA.payload.currency,
    customerName: validA.payload.customerName,
    customerEmail: validA.payload.customerEmail,
    customerPhone: validA.payload.customerPhone,
    description: validA.payload.description,
    successUrl: validA.payload.successUrl,
    callbackUrl: validA.payload.callbackUrl,
    cancelUrl: validA.payload.cancelUrl,
    webhookUrl: validA.payload.webhookUrl,
    metadata: validA.payload.metadata
  });
  assert(idempotentA.response.status === 200, `idempotent duplicate should return 200, got ${idempotentA.response.status}`);
  assert(
    (idempotentA.body as { session: { id: string } }).session.id === sessionA.id,
    'idempotent duplicate did not return existing session'
  );
  console.log('PASS idempotent duplicate');

  await expectFailure(
    'invalid signature',
    () =>
      createPaymentSession(fixtureA, {
        signature: `${validA.payload.signature.slice(0, -1)}0`
      }),
    401
  );

  await expectFailure(
    'expired timestamp',
    () =>
      createPaymentSession(fixtureA, {
        timestamp: Math.floor(Date.now() / 1000 - 6000).toString()
      }),
    401
  );

  await expectFailure(
    'replay nonce',
    async () => {
      const replay = await requestJson('/api/v1/payment-sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN
        },
        body: JSON.stringify({
          ...validA.payload,
          timestamp: validA.payload.timestamp,
          nonce: validA.payload.nonce,
          signature: validA.payload.signature
        })
      });
      return replay;
    },
    401
  );

  await expectFailure(
    'wrong origin',
    () =>
      createPaymentSession(fixtureA, {
        origin: 'http://malicious.example'
      }),
    403
  );

  await expectFailure(
    'duplicate order different amount',
    () =>
      createPaymentSession(fixtureA, {
        merchantOrderId: validA.payload.merchantOrderId,
        amount: 9999
      }),
    409
  );

  const fixtureB = await createMerchantFixture(adminToken, 'b');
  const revokedKeyAttempt = await createPaymentSession(fixtureB);
  assert(revokedKeyAttempt.response.status === 201, 'fixture B create failed');
  const revokeRes = await adminRequest(adminToken, `/api/v1/admin/merchant-api-keys/${fixtureB.apiKeyId}/revoke`, {
    method: 'POST'
  });
  assert(revokeRes.response.status === 200, `revoke failed: ${JSON.stringify(revokeRes.body)}`);
  await expectFailure(
    'revoked key',
    () => createPaymentSession(fixtureB, { merchantOrderId: `revoked_${Date.now()}` }),
    401
  );

  const fixtureC = await createMerchantFixture(adminToken, 'c');
  const suspendRes = await adminRequest(adminToken, `/api/v1/admin/merchants/${fixtureC.merchantId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'SUSPENDED' })
  });
  assert(suspendRes.response.status === 200, `suspend failed: ${JSON.stringify(suspendRes.body)}`);
  await expectFailure(
    'suspended merchant',
    () => createPaymentSession(fixtureC, { merchantOrderId: `suspended_${Date.now()}` }),
    403
  );

  await delay(50);
  console.log('ALL PASS');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
