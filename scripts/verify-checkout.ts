import { createHash, createHmac, randomBytes } from 'node:crypto';
import { prisma } from '../src/config/prisma.js';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';
const ADMIN_EMAIL = process.env.VERIFY_ADMIN_EMAIL ?? 'admin@worldpetsassociation.com';
const ADMIN_PASSWORD = process.env.VERIFY_ADMIN_PASSWORD ?? 'WpaAdmin123!';
const ALLOWED_ORIGIN = process.env.VERIFY_ALLOWED_ORIGIN ?? 'http://localhost:3000';

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
const sha256Hex = (payload: string) => createHash('sha256').update(payload).digest('hex');
const canonical = (method: string, path: string, timestamp: string, body: string) =>
  `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256Hex(body)}`;

const sign = (secret: string, body: JsonObject, timestamp: string, nonce: string) =>
  createHmac('sha256', secret).update(canonical('POST', '/api/v1/payment-sessions', timestamp, stableJson({ ...body, timestamp, nonce }))).digest('hex');

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
  const merchantEmail = `checkout-${suffix}-${Date.now()}@example.com`;
  const { response: merchantRes, body: merchantBody } = await adminRequest(token, '/api/v1/admin/merchants', {
    method: 'POST',
    body: JSON.stringify({
      name: `Checkout Merchant ${suffix}`,
      business_name: `Checkout Merchant ${suffix} LLC`,
      contact_email: merchantEmail,
      contact_phone: '+1 555 010 5555',
      status: 'ACTIVE',
      environment: 'SANDBOX',
      notes: 'Checkout verification merchant'
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
      label: `checkout-${suffix}`,
      environment: 'SANDBOX'
    })
  });
  assert(keyRes.status === 201, `API key create failed: ${JSON.stringify(keyBody)}`);
  const key = keyBody as { key: { id: string }; credentials: { client_id: string; client_secret: string } };

  return {
    merchantId: merchant.id,
    apiKeyId: key.key.id,
    clientId: key.credentials.client_id,
    clientSecret: key.credentials.client_secret
  };
};

const createPaymentSession = async (fixture: { clientId: string; clientSecret: string }, merchantOrderId: string) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(12).toString('hex');
  const payload = {
    clientId: fixture.clientId,
    merchantOrderId,
    amount: 1299,
    currency: 'USD',
    customerName: 'Checkout Customer',
    customerEmail: 'customer@example.com',
    customerPhone: '+1 555 010 6000',
    description: 'Checkout verification order',
    successUrl: `${ALLOWED_ORIGIN}/success`,
    callbackUrl: `${ALLOWED_ORIGIN}/callback`,
    cancelUrl: `${ALLOWED_ORIGIN}/cancel`,
    webhookUrl: `${ALLOWED_ORIGIN}/webhook`,
    metadata: { source: 'checkout-verifier' }
  };

  const signature = sign(fixture.clientSecret, payload, timestamp, nonce);
  const { response, body } = await requestJson('/api/v1/payment-sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      ...payload,
      timestamp,
      nonce,
      signature
    })
  });

  assert(response.status === 201, `Payment session create failed: ${JSON.stringify(body)}`);
  return body as { session: { reference: string } };
};

const main = async () => {
  const adminToken = await adminLogin();
  const fixture = await createFixture(adminToken, 'checkout');

  const created = await createPaymentSession(fixture, `order_${Date.now()}`);
  const reference = created.session.reference;

  const safeResponse = await requestJson(`/api/v1/checkout/${reference}`, {
    method: 'GET',
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert(safeResponse.response.ok, `Checkout read failed: ${JSON.stringify(safeResponse.body)}`);
  const safeSession = (safeResponse.body as { session: { providers: Array<{ providerCode: string; status: string }> } }).session;
  assert(Array.isArray(safeSession.providers) && safeSession.providers.length > 0, 'Expected at least one provider');
  assert(safeSession.providers.every((provider) => provider.status === 'ACTIVE'), 'Inactive provider returned in checkout list');
  assert(!JSON.stringify(safeResponse.body).includes(fixture.clientSecret), 'Checkout response leaked client secret');

  const invalidResponse = await requestJson('/api/v1/checkout/does-not-exist', {
    method: 'GET',
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert(invalidResponse.response.status === 404, 'Invalid reference should return 404');

  const payResponse = await requestJson(`/api/v1/checkout/${reference}/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      providerCode: safeSession.providers[0].providerCode
    })
  });
  assert(payResponse.response.status === 503, `Expected provider config error, got ${payResponse.response.status}: ${JSON.stringify(payResponse.body)}`);
  assert(
    (payResponse.body as { error?: { code?: string } }).error?.code === 'PROVIDER_NOT_CONFIGURED',
    'Provider config error code missing'
  );

  const transactionCount = await prisma.transaction.count({
    where: { session: { reference } }
  });
  assert(transactionCount > 0, 'Pay attempt did not create a transaction record');

  const statusResponse = await requestJson(`/api/v1/checkout/${reference}/status`, {
    method: 'GET',
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert(statusResponse.response.ok, 'Status endpoint should be readable');

  const expiredReference = (await createPaymentSession(fixture, `expired_${Date.now()}`)).session.reference;
  await prisma.paymentSession.update({
    where: { reference: expiredReference },
    data: {
      expiresAt: new Date(Date.now() - 60_000)
    }
  });
  const expiredRead = await requestJson(`/api/v1/checkout/${expiredReference}`, {
    method: 'GET',
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert(expiredRead.response.status === 404, 'Expired session should not be readable');
  const expiredPay = await requestJson(`/api/v1/checkout/${expiredReference}/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      providerCode: safeSession.providers[0].providerCode
    })
  });
  assert(expiredPay.response.status === 410, 'Expired session should not be payable');

  const cancelledReference = (await createPaymentSession(fixture, `cancelled_${Date.now()}`)).session.reference;
  await prisma.paymentSession.update({
    where: { reference: cancelledReference },
    data: {
      status: 'CANCELLED'
    }
  });
  const cancelledPay = await requestJson(`/api/v1/checkout/${cancelledReference}/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      providerCode: safeSession.providers[0].providerCode
    })
  });
  assert(cancelledPay.response.status === 410, 'Cancelled session should not be payable');

  const successReference = (await createPaymentSession(fixture, `success_${Date.now()}`)).session.reference;
  await prisma.paymentSession.update({
    where: { reference: successReference },
    data: {
      status: 'SUCCESS'
    }
  });
  const successPay = await requestJson(`/api/v1/checkout/${successReference}/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      providerCode: safeSession.providers[0].providerCode
    })
  });
  assert(successPay.response.status === 410, 'Completed session should not be payable');

  console.log('ALL PASS');
};

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
