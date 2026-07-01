/**
 * WPA Gateway — Create Payment Session Example
 *
 * Setup:
 *   1. Copy examples/node/.env.example to examples/node/.env
 *   2. Fill in WPA_CLIENT_ID, WPA_CLIENT_SECRET from the Admin Panel
 *   3. Run: npx tsx examples/node/create-payment-session.ts
 *
 * This script calls POST /api/v1/payment-sessions and prints the checkout URL.
 * Run it against your local gateway (WPA_GATEWAY_URL=http://localhost:4000).
 */

import 'dotenv/config';
import { createPaymentSession } from './wpa-sdk.js';

const GATEWAY_URL   = process.env.WPA_GATEWAY_URL   ?? 'http://localhost:4000';
const CLIENT_ID     = process.env.WPA_CLIENT_ID;
const CLIENT_SECRET = process.env.WPA_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
ERROR: WPA credentials not configured.

Create a .env file in examples/node/ with:

  WPA_GATEWAY_URL=http://localhost:4000
  WPA_CLIENT_ID=wpa_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
  WPA_CLIENT_SECRET=wpa_secret_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Get these values from the WPA Admin Panel:
  → Merchants → furtail.app → API Keys → Create API Key (SANDBOX)
  `);
  process.exit(1);
}

// Unique order ID — in production this comes from your database
const TEST_ORDER_ID = `test_order_${Date.now()}`;

async function main() {
  console.log(`Creating payment session for order: ${TEST_ORDER_ID}`);
  console.log(`Gateway: ${GATEWAY_URL}\n`);

  try {
    const result = await createPaymentSession(GATEWAY_URL, CLIENT_SECRET!, {
      clientId: CLIENT_ID!,
      merchantOrderId: TEST_ORDER_ID,
      amount: 4999,               // $49.99 in cents
      currency: 'USD',
      customerName: 'Jane Doe',
      customerEmail: 'jane@example.com',
      customerPhone: '+1 555 010 2400',
      description: 'Premium pet care subscription',
      successUrl: 'https://furtail.app/payments/success',
      cancelUrl: 'https://furtail.app/payments/cancel',
      callbackUrl: 'https://furtail.app/wpa/callback',
      webhookUrl: 'https://furtail.app/wpa/webhook',
      metadata: { userId: 'usr_789', plan: 'premium' }
    });

    const checkoutUrl = `${GATEWAY_URL}${result.session.paymentUrl}`;

    console.log('✅ Payment session created\n');
    console.log(`  Reference    : ${result.session.reference}`);
    console.log(`  Status       : ${result.session.status}`);
    console.log(`  Amount       : ${result.session.amount} ${result.session.currency}`);
    console.log(`  Order ID     : ${result.session.merchantOrderId}`);
    console.log(`  Expires      : ${result.session.expiresAt}`);
    console.log(`\n  ➜ Checkout URL: ${checkoutUrl}\n`);

    // Test idempotency — same order ID should return the existing session
    console.log('Testing idempotency (same merchantOrderId) ...');
    const idempotentResult = await createPaymentSession(GATEWAY_URL, CLIENT_SECRET!, {
      clientId: CLIENT_ID!,
      merchantOrderId: TEST_ORDER_ID, // same order ID
      amount: 4999,
      currency: 'USD',
      customerName: 'Jane Doe',
      customerEmail: 'jane@example.com',
      customerPhone: '+1 555 010 2400',
      description: 'Premium pet care subscription',
      successUrl: 'https://furtail.app/payments/success',
      cancelUrl: 'https://furtail.app/payments/cancel',
      callbackUrl: 'https://furtail.app/wpa/callback',
      webhookUrl: 'https://furtail.app/wpa/webhook',
      metadata: { userId: 'usr_789', plan: 'premium' }
    });

    if (idempotentResult.session.reference === result.session.reference) {
      console.log('✅ Idempotency confirmed — same reference returned\n');
    } else {
      console.error('❌ Idempotency FAILED — different reference returned!');
      process.exitCode = 1;
    }

  } catch (error) {
    console.error('❌ Request failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
