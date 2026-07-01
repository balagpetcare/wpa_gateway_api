/**
 * E2E Sandbox QA script: Furtail ↔ WPA Gateway ↔ EPS
 *
 * Verifies the complete payment flow without triggering real money movement.
 * Requires both servers running and Furtail merchant registered in WPA Gateway.
 *
 * Usage:
 *   WPA_BASE=http://localhost:4000 \
 *   FURTAIL_BASE=http://localhost:7200 \
 *   WPA_CLIENT_ID=<clientId> \
 *   WPA_CLIENT_SECRET=<secret> \
 *   npx tsx scripts/verify-wpa-furtail-e2e.ts
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const WPA_BASE = process.env.WPA_BASE ?? 'http://127.0.0.1:4000';
const FURTAIL_BASE = process.env.FURTAIL_BASE ?? 'http://127.0.0.1:7200';
const CLIENT_ID = process.env.WPA_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.WPA_CLIENT_SECRET ?? '';

type Json = Record<string, unknown>;

// ─── Canonical signing (must match wpa-gateway-client.ts) ─────────────────────

const stableJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.keys(input as Json).sort().reduce<Json>((acc, key) => {
        acc[key] = normalize((input as Json)[key]);
        return acc;
      }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hmacHex = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

const signRequest = (method: string, path: string, body: unknown, secret: string) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const canonicalBody = stableJson(body);
  const bodyHash = sha256Hex(canonicalBody);
  const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = hmacHex(secret, canonical);
  return { timestamp, nonce, signature, canonicalBody };
};

const wpaPost = async (path: string, body: unknown): Promise<Json> => {
  const { timestamp, nonce, signature, canonicalBody } = signRequest('POST', path, body, CLIENT_SECRET);
  const res = await fetch(`${WPA_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': CLIENT_ID,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body: canonicalBody,
  });
  const json = await res.json() as Json;
  if (!res.ok) throw new Error(`WPA ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

// ─── Webhook simulation ────────────────────────────────────────────────────────

const signWebhook = (payload: Json, secret: string) => {
  const body = JSON.stringify(payload);
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
};

const sendFurtailWebhook = async (payload: Json, secret: string) => {
  const body = JSON.stringify(payload);
  const sig = signWebhook(payload, secret);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const res = await fetch(`${FURTAIL_BASE}/api/v1/payments/wpa/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-signature': sig,
      'x-gateway-timestamp': timestamp,
      'x-gateway-nonce': nonce,
      'x-gateway-event': String(payload.event ?? 'payment.succeeded'),
    },
    body,
  });
  return { status: res.status, json: await res.json() as Json };
};

// ─── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

const ok = (name: string, detail = '') => {
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  passed++;
};

const fail = (name: string, reason: string) => {
  console.error(`  ❌ ${name}: ${reason}`);
  failed++;
};

const assert = (name: string, condition: boolean, failDetail: string) => {
  condition ? ok(name) : fail(name, failDetail);
};

// ─── Test 1: Amount unit — ৳600 must arrive at WPA as 600 (not 60000) ────────

async function testAmountUnit() {
  console.log('\n[1] Amount Unit Audit — ৳600 must stay ৳600 through Furtail → WPA\n');

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('  ⚠️  WPA_CLIENT_ID / WPA_CLIENT_SECRET not set — skipping live session test');
    return;
  }

  const nonce = randomBytes(16).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));

  const sessionBodyWithoutSig = {
    clientId: CLIENT_ID,
    merchantOrderId: `E2E-AMOUNT-${Date.now()}`,
    amount: 600,
    currency: 'BDT',
    customerName: 'E2E Test',
    customerEmail: 'e2e@furtail.com',
    customerPhone: '+8801700000000',
    successUrl: `${FURTAIL_BASE}/api/v1/payments/wpa/return`,
    callbackUrl: `${FURTAIL_BASE}/api/v1/payments/wpa/return`,
    cancelUrl: `${FURTAIL_BASE}/api/v1/payments/wpa/return`,
    webhookUrl: `${FURTAIL_BASE}/api/v1/payments/wpa/webhook`,
    description: 'E2E sandbox amount audit',
    timestamp,
    nonce,
  };

  const signaturePayload = stableJson({
    clientId: sessionBodyWithoutSig.clientId,
    merchantOrderId: sessionBodyWithoutSig.merchantOrderId,
    amount: sessionBodyWithoutSig.amount,
    currency: sessionBodyWithoutSig.currency,
    customerName: sessionBodyWithoutSig.customerName,
    customerEmail: sessionBodyWithoutSig.customerEmail,
    customerPhone: sessionBodyWithoutSig.customerPhone,
    description: sessionBodyWithoutSig.description,
    successUrl: sessionBodyWithoutSig.successUrl,
    callbackUrl: sessionBodyWithoutSig.callbackUrl,
    cancelUrl: sessionBodyWithoutSig.cancelUrl,
    webhookUrl: sessionBodyWithoutSig.webhookUrl,
    metadata: null,
    timestamp: sessionBodyWithoutSig.timestamp,
    nonce: sessionBodyWithoutSig.nonce
  });

  const bodyHash = sha256Hex(signaturePayload);
  const canonical = `POST\n/api/v1/payment-sessions\n${timestamp}\n${bodyHash}`;
  const signature = hmacHex(CLIENT_SECRET, canonical);

  const sessionBody = {
    ...sessionBodyWithoutSig,
    signature,
  };

  try {
    const res = await fetch(`${WPA_BASE}/api/v1/payment-sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sessionBody),
    });
    const responseData = await res.json() as { success: boolean; session?: Json & { amount?: number; reference?: string; paymentUrl?: string } };
    if (!res.ok) throw new Error(`WPA /api/v1/payment-sessions → ${res.status}: ${JSON.stringify(responseData)}`);
    const session = responseData.session || {};

    assert(
      'WPA session created successfully',
      !!session.reference,
      `no reference in: ${JSON.stringify(session)}`
    );

    assert(
      'WPA stores amount as 600 BDT (not paisa 60000)',
      session.amount === 600,
      `expected 600, got ${session.amount}`
    );

    assert(
      'paymentUrl is hosted checkout link',
      typeof session.paymentUrl === 'string' && session.paymentUrl.includes('/checkout/'),
      `unexpected paymentUrl: ${session.paymentUrl}`
    );

    console.log(`  ℹ  Session reference: ${session.reference}, amount: ${session.amount} BDT`);
    console.log(`  ℹ  Checkout URL: ${WPA_BASE}${session.paymentUrl}`);
    console.log(`  ℹ  → Open this URL in browser to test EPS sandbox payment`);

    return session.reference as string | undefined;
  } catch (err) {
    fail('WPA session creation', (err as Error).message);
  }
}

// ─── Test 2: Webhook signature verification on Furtail side ──────────────────

async function testWebhookSignature() {
  console.log('\n[2] Webhook Signature — Furtail must reject invalid signatures\n');

  const orderId = `E2E-SIG-${Date.now()}`;
  const goodPayload: Json = {
    event: 'payment.succeeded',
    merchantOrderId: orderId,
    gatewayReference: `wps_e2e_${Date.now()}`,
    transactionReference: `txn_e2e_${Date.now()}`,
    amount: 600,
    currency: 'BDT',
    status: 'SUCCESS',
    paidAt: new Date().toISOString(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(16).toString('hex'),
  };

  if (!CLIENT_SECRET) {
    console.log('  ⚠️  WPA_CLIENT_SECRET not set — skipping live webhook test');
    return;
  }

  // 2a. Invalid signature rejected
  const body = JSON.stringify(goodPayload);
  const wrongSig = hmacHex('wrong_secret_xyz', body);
  const badRes = await fetch(`${FURTAIL_BASE}/api/v1/payments/wpa/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-signature': wrongSig,
      'x-gateway-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-gateway-nonce': randomBytes(16).toString('hex'),
      'x-gateway-event': 'payment.succeeded',
    },
    body,
  });
  assert('Invalid signature rejected with 401', badRes.status === 401, `got ${badRes.status}`);

  // 2b. Stale timestamp rejected
  const staleRes = await fetch(`${FURTAIL_BASE}/api/v1/payments/wpa/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-signature': signWebhook(goodPayload, CLIENT_SECRET),
      'x-gateway-timestamp': String(Math.floor(Date.now() / 1000) - 400),
      'x-gateway-nonce': randomBytes(16).toString('hex'),
      'x-gateway-event': 'payment.succeeded',
    },
    body,
  });
  assert('Stale timestamp (>300s) rejected with 401', staleRes.status === 401, `got ${staleRes.status}`);

  // 2c. Missing nonce rejected
  const noNonceRes = await fetch(`${FURTAIL_BASE}/api/v1/payments/wpa/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-signature': signWebhook(goodPayload, CLIENT_SECRET),
      'x-gateway-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-gateway-event': 'payment.succeeded',
    },
    body,
  });
  assert('Missing nonce rejected with 401', noNonceRes.status === 401, `got ${noNonceRes.status}`);
}

// ─── Test 3: Duplicate success is idempotent ──────────────────────────────────

async function testIdempotency() {
  console.log('\n[3] Idempotency — Duplicate success webhook must return 200 without re-processing\n');

  if (!CLIENT_SECRET) {
    console.log('  ⚠️  WPA_CLIENT_SECRET not set — skipping');
    return;
  }

  const orderId = 'E2E-IDEM-ORDER';
  const nonce = randomBytes(16).toString('hex');
  const payload: Json = {
    event: 'payment.succeeded',
    merchantOrderId: orderId,
    gatewayReference: `wps_idem_${Date.now()}`,
    transactionReference: `txn_idem_${Date.now()}`,
    amount: 600,
    currency: 'BDT',
    status: 'SUCCESS',
    paidAt: new Date().toISOString(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce,
  };

  const first = await sendFurtailWebhook(payload, CLIENT_SECRET);
  console.log(`  ℹ  First webhook response: ${first.status}`);

  // Second call with a different nonce but same payload (merchantOrderId + event) to trigger the duplicate check (idempotency) returning 200 duplicate: true
  const differentNonce = randomBytes(16).toString('hex');
  const payloadWithNewNonce = {
    ...payload,
    nonce: differentNonce,
  };
  const second = await sendFurtailWebhook(payloadWithNewNonce, CLIENT_SECRET);
  assert(
    'Duplicate success event is idempotent (200 OK with duplicate: true)',
    second.status === 200 && second.json?.duplicate === true,
    `got ${second.status}: ${JSON.stringify(second.json)}`
  );
}

// ─── Test 4: Health checks ────────────────────────────────────────────────────

async function testHealthChecks() {
  console.log('\n[4] Health Checks — Both servers must be reachable\n');

  try {
    const wpaHealth = await fetch(`${WPA_BASE}/health`);
    assert('WPA Gateway /health responds 200', wpaHealth.status === 200, `got ${wpaHealth.status}`);
  } catch {
    fail('WPA Gateway /health', `server not reachable at ${WPA_BASE}`);
  }

  try {
    const furtailHealth = await fetch(`${FURTAIL_BASE}/health`);
    assert('Furtail API /health responds 200', furtailHealth.status === 200, `got ${furtailHealth.status}`);
  } catch {
    fail('Furtail API /health', `server not reachable at ${FURTAIL_BASE}`);
  }
}

// ─── Test 5: Security — client secret never in Furtail API responses ─────────

async function testSecretNotLeaked() {
  console.log('\n[5] Security — WPA_CLIENT_SECRET must never appear in API responses\n');

  // Furtail initiate endpoint returns paymentUrl but not credentials
  const res = await fetch(`${FURTAIL_BASE}/api/v1/payments/wpa/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookingId: 99999, returnUrl: 'https://app.furtail.com/return' }),
  });

  const text = await res.text();
  if (CLIENT_SECRET && text.includes(CLIENT_SECRET)) {
    fail('CLIENT_SECRET not leaked in initiate response', 'secret found in response body');
  } else {
    ok('WPA_CLIENT_SECRET absent from initiate response');
  }

  assert(
    'Initiate endpoint never returns 200 for non-existent booking',
    res.status !== 200,
    'should be 400/404 for non-existent booking'
  );
}

// ─── Run all tests ────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  WPA ↔ Furtail E2E Sandbox QA');
  console.log(`  WPA Gateway:  ${WPA_BASE}`);
  console.log(`  Furtail API:  ${FURTAIL_BASE}`);
  console.log(`  Client ID:    ${CLIENT_ID || '(not set)'}`);
  console.log('═══════════════════════════════════════════════════════════');

  await testHealthChecks();
  await testAmountUnit();
  await testWebhookSignature();
  await testIdempotency();
  await testSecretNotLeaked();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
})();
