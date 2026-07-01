import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ProviderName } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { encryptValue } from '../src/utils/encrypt.js';

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

const createFixture = async (token: string, suffix: string, currency: 'USD' | 'BDT') => {
  const merchantEmail = `eps-${suffix}-${Date.now()}@example.com`;
  const { response: merchantRes, body: merchantBody } = await adminRequest(token, '/api/v1/admin/merchants', {
    method: 'POST',
    body: JSON.stringify({
      name: `EPS Merchant ${suffix}`,
      business_name: `EPS Merchant ${suffix} LLC`,
      contact_email: merchantEmail,
      contact_phone: '+8801712345678',
      status: 'ACTIVE',
      environment: 'SANDBOX',
      notes: 'EPS verification merchant'
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
      label: `eps-${suffix}`,
      environment: 'SANDBOX'
    })
  });
  assert(keyRes.status === 201, `API key create failed: ${JSON.stringify(keyBody)}`);
  const key = keyBody as { key: { id: string }; credentials: { client_id: string; client_secret: string } };

  return {
    merchantId: merchant.id,
    apiKeyId: key.key.id,
    clientId: key.credentials.client_id,
    clientSecret: key.credentials.client_secret,
    currency
  };
};

const createPaymentSession = async (
  fixture: { clientId: string; clientSecret: string; currency: 'USD' | 'BDT' },
  merchantOrderId: string
) => {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(12).toString('hex');
  const payload = {
    clientId: fixture.clientId,
    merchantOrderId,
    amount: fixture.currency === 'BDT' ? 1500 : 1299,
    currency: fixture.currency,
    customerName: 'EPS Checkout Customer',
    customerEmail: 'customer@example.com',
    customerPhone: '+8801712345678',
    description: 'EPS verification order',
    successUrl: `${ALLOWED_ORIGIN}/success`,
    callbackUrl: `${ALLOWED_ORIGIN}/callback`,
    cancelUrl: `${ALLOWED_ORIGIN}/cancel`,
    webhookUrl: `${ALLOWED_ORIGIN}/webhook`,
    metadata: { source: 'eps-verifier' }
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

const ensureEpsProvider = async () => {
  const provider = await prisma.paymentProvider.upsert({
    where: { name: ProviderName.EPS },
    update: {
      displayName: 'EPS Sandbox',
      supportedCurrencies: ['BDT'],
      supportedCountries: ['BD']
    },
    create: {
      name: ProviderName.EPS,
      displayName: 'EPS Sandbox',
      isActive: false,
      supportedCurrencies: ['BDT'],
      supportedCountries: ['BD'],
      priority: 1
    }
  });

  return provider;
};

const deactivateEpsCredentials = async (providerId: string) => {
  await prisma.providerCredential.updateMany({
    where: { providerId, merchantId: null },
    data: { isActive: false }
  });
};

const activateEpsCredentialsIfConfigured = async (providerId: string) => {
  const configured = {
    username: process.env.VERIFY_EPS_USERNAME,
    password: process.env.VERIFY_EPS_PASSWORD,
    hashKey: process.env.VERIFY_EPS_HASH_KEY,
    merchantId: process.env.VERIFY_EPS_MERCHANT_ID,
    storeId: process.env.VERIFY_EPS_STORE_ID,
    baseUrl: process.env.VERIFY_EPS_BASE_URL ?? 'https://sandbox-pgapi.eps.com.bd',
    sandbox: 'true'
  };

  const hasAll = Object.values(configured).every((value) => typeof value === 'string' && value.length > 0);
  if (!hasAll) {
    return false;
  }

  for (const [keyLabel, value] of Object.entries(configured)) {
    const encrypted = encryptValue(value as string, env.CREDENTIAL_ENCRYPTION_KEY);
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

  return true;
};

const ensureMerchantProviderSetting = async (merchantId: string, providerId: string, currency: 'USD' | 'BDT') => {
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
      currencies: [currency],
      countries: currency === 'BDT' ? ['BD'] : ['US']
    },
    create: {
      merchantId,
      providerId,
      isEnabled: true,
      priority: 1,
      currencies: [currency],
      countries: currency === 'BDT' ? ['BD'] : ['US']
    }
  });
};

const main = async () => {
  const token = await adminLogin();
  const epsProvider = await ensureEpsProvider();

  await prisma.paymentProvider.update({
    where: { id: epsProvider.id },
    data: { isActive: false }
  });

  const usdFixture = await createFixture(token, 'usd', 'USD');
  const usdSession = await createPaymentSession(usdFixture, `usd_${Date.now()}`);
  const usdCheckout = await requestJson(`/api/v1/checkout/${usdSession.session.reference}`, {
    method: 'GET',
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert(usdCheckout.response.ok, `Checkout read failed: ${JSON.stringify(usdCheckout.body)}`);
  const usdProviders = ((usdCheckout.body as { session: { providers: Array<{ providerCode: string }> } }).session.providers ?? []);
  assert(usdProviders.every((provider) => provider.providerCode !== 'EPS'), 'Inactive EPS provider should not be listed');

  await prisma.paymentProvider.update({
    where: { id: epsProvider.id },
    data: { isActive: true }
  });
  await deactivateEpsCredentials(epsProvider.id);

  const bdtFixture = await createFixture(token, 'bdt', 'BDT');
  await ensureMerchantProviderSetting(bdtFixture.merchantId, epsProvider.id, 'BDT');
  const bdtSession = await createPaymentSession(bdtFixture, `bdt_${Date.now()}`);

  const bdtCheckout = await requestJson(`/api/v1/checkout/${bdtSession.session.reference}`, {
    method: 'GET',
    headers: { origin: ALLOWED_ORIGIN }
  });
  assert(bdtCheckout.response.ok, `BDT checkout read failed: ${JSON.stringify(bdtCheckout.body)}`);
  const bdtProviders = ((bdtCheckout.body as { session: { providers: Array<{ providerCode: string }> } }).session.providers ?? []);
  assert(bdtProviders.some((provider) => provider.providerCode === 'EPS'), 'Active EPS provider should be listed for BDT checkout');

  const unconfiguredPay = await requestJson(`/api/v1/checkout/${bdtSession.session.reference}/pay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN
    },
    body: JSON.stringify({
      providerCode: 'EPS'
    })
  });
  assert(unconfiguredPay.response.status === 503, `Expected safe EPS configuration failure: ${JSON.stringify(unconfiguredPay.body)}`);
  assert((unconfiguredPay.body as { error?: { code?: string } }).error?.code === 'PROVIDER_NOT_CONFIGURED', 'Expected PROVIDER_NOT_CONFIGURED');

  const sandboxReady = await activateEpsCredentialsIfConfigured(epsProvider.id);
  if (sandboxReady) {
    const configuredSession = await createPaymentSession(bdtFixture, `eps_${Date.now()}`);
    const configuredPay = await requestJson(`/api/v1/checkout/${configuredSession.session.reference}/pay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN
      },
      body: JSON.stringify({
        providerCode: 'EPS'
      })
    });

    assert(configuredPay.response.ok, `Configured EPS initiate failed: ${JSON.stringify(configuredPay.body)}`);
    const payBody = configuredPay.body as {
      paymentUrl?: string;
      transaction?: { status?: string; providerCode?: string };
      session?: { status?: string };
    };
    assert(typeof payBody.paymentUrl === 'string' && payBody.paymentUrl.startsWith('http'), 'Expected EPS redirect URL');
    assert(payBody.transaction?.status === 'PENDING', 'EPS initiate must keep transaction pending');
    assert(payBody.session?.status === 'PENDING', 'EPS initiate must keep session pending');

    const stored = await prisma.paymentSession.findUniqueOrThrow({
      where: { reference: configuredSession.session.reference },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    assert(stored.status === 'PENDING', 'Session must remain pending after EPS initiate');
    assert(stored.transactions[0]?.status === 'PENDING', 'Transaction must remain pending after EPS initiate');
    assert(!JSON.stringify(payBody).includes(process.env.VERIFY_EPS_PASSWORD ?? ''), 'Public response leaked EPS credentials');

    console.log('PASS: EPS configured path returned a real redirect URL and preserved pending state');
  } else {
    console.log('PASS: EPS unconfigured path verified. Set VERIFY_EPS_* env vars to test live sandbox initiation.');
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
