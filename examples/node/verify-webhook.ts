/**
 * WPA Gateway — Webhook Verification Example
 *
 * Demonstrates:
 *   1. How to verify a valid gateway webhook signature
 *   2. How to detect a tampered/invalid signature
 *   3. How to parse and handle payment events
 *
 * Run: npx tsx examples/node/verify-webhook.ts
 * (Does not require real credentials — uses synthetic test data)
 */

import { createHmac } from 'node:crypto';
import { verifyGatewayWebhook, stableJsonStringify, type GatewayWebhookPayload } from './wpa-sdk.js';

// ─── Synthetic test data ──────────────────────────────────────────────────────

const TEST_SECRET = 'wpa_secret_test_aabbccddeeff00112233445566778899aabbccddeeff00112233';

const validPayload: GatewayWebhookPayload = {
  event: 'payment.succeeded',
  merchantOrderId: 'order_12345',
  gatewayReference: 'wps_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
  transactionReference: 'eps_txn_abc123',
  amount: 4999,
  currency: 'USD',
  status: 'SUCCESS',
  paidAt: new Date().toISOString(),
  timestamp: Math.floor(Date.now() / 1000),
  nonce: 'a1b2c3d4e5f6g7h8i9j0k1l2'
};

// The gateway sends stableJsonStringify(payload) as the HTTP body
const rawBody = stableJsonStringify(validPayload);
const validSignature = createHmac('sha256', TEST_SECRET).update(rawBody).digest('hex');

// ─── Tests ────────────────────────────────────────────────────────────────────

let allPassed = true;

function test(name: string, result: boolean) {
  const icon = result ? '✅' : '❌';
  console.log(`${icon} ${name}`);
  if (!result) allPassed = false;
}

console.log('WPA Webhook Verification Tests\n');

// Test 1: Valid signature should pass
test(
  'Valid signature accepted',
  verifyGatewayWebhook(rawBody, TEST_SECRET, validSignature)
);

// Test 2: Wrong secret should fail
test(
  'Wrong secret rejected',
  !verifyGatewayWebhook(rawBody, 'wrong_secret', validSignature)
);

// Test 3: Tampered body should fail
const tamperedBody = rawBody.replace('"amount":4999', '"amount":1');
test(
  'Tampered body rejected',
  !verifyGatewayWebhook(tamperedBody, TEST_SECRET, validSignature)
);

// Test 4: Tampered signature should fail
const tamperedSig = validSignature.replace(validSignature.slice(0, 4), 'ffff');
test(
  'Tampered signature rejected',
  !verifyGatewayWebhook(rawBody, TEST_SECRET, tamperedSig)
);

// Test 5: Empty signature should fail
test(
  'Empty signature rejected',
  !verifyGatewayWebhook(rawBody, TEST_SECRET, '')
);

// Test 6: Signature over Buffer (not string) should match
const bodyBuffer = Buffer.from(rawBody, 'utf8');
test(
  'Buffer body verification matches string body',
  verifyGatewayWebhook(bodyBuffer, TEST_SECRET, validSignature)
);

// Test 7: Parse and handle payment events
console.log('\nEvent handling demonstration:\n');

function handleGatewayEvent(payload: GatewayWebhookPayload) {
  switch (payload.event) {
    case 'payment.succeeded':
      console.log(`  → FULFILL order ${payload.merchantOrderId}`);
      console.log(`    Amount  : ${payload.amount} ${payload.currency}`);
      console.log(`    Ref     : ${payload.gatewayReference}`);
      console.log(`    Paid at : ${payload.paidAt}`);
      break;
    case 'payment.failed':
      console.log(`  → MARK FAILED order ${payload.merchantOrderId}`);
      break;
    case 'payment.cancelled':
      console.log(`  → MARK CANCELLED order ${payload.merchantOrderId}`);
      break;
    default:
      console.log(`  → IGNORE event: ${payload.event}`);
  }
}

handleGatewayEvent(validPayload);
handleGatewayEvent({ ...validPayload, event: 'payment.failed', status: 'FAILED', paidAt: null });
handleGatewayEvent({ ...validPayload, event: 'payment.cancelled', status: 'CANCELLED', paidAt: null });

console.log();

if (!allPassed) {
  console.error('One or more tests FAILED.');
  process.exitCode = 1;
} else {
  console.log('All webhook verification tests passed.');
}
