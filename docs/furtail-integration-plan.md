# Furtail × WPA Gateway — Integration Plan

This document describes how `furtail.app` (or `furtail_api`) should integrate with the WPA Payment Gateway for pet care subscription and one-time payments.

---

## Architecture Overview

```
furtail_app (frontend)         furtail_api (backend)         WPA Gateway
       |                              |                            |
       |-- "Pay Now" clicked ------→ |                            |
       |                              |-- POST /api/v1/payment-sessions →|
       |                              |←── { paymentUrl, reference } ─── |
       |←── redirect to paymentUrl ──|                            |
       |                              |                            |
       | (customer pays on WPA hosted checkout)                   |
       |                              |                            |
       |                              |←── POST /wpa/webhook ──────|
       |                              | (x-gateway-signature)      |
       |                              | Verify signature           |
       |                              | Update order in DB         |
       |                              | Respond 200                |
       |                              |                            |
       |←── redirect to successUrl ──|                            |
       |   (display status only)      |                            |
```

**Core rule:** The frontend only displays payment status. It never marks an order as paid. Only the backend webhook handler — after verifying `x-gateway-signature` — marks an order as paid.

---

## Environment Variables (furtail_api)

```env
# WPA Gateway
WPA_GATEWAY_URL=https://gateway.worldpetsassociation.com
WPA_CLIENT_ID=wpa_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
WPA_CLIENT_SECRET=wpa_secret_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Furtail callback endpoint (must be in WPA domain allowlist)
WPA_WEBHOOK_URL=https://api.furtail.app/payments/wpa/webhook
WPA_CALLBACK_URL=https://api.furtail.app/payments/wpa/callback

# Furtail frontend
FURTAIL_SUCCESS_URL=https://furtail.app/checkout/success
FURTAIL_CANCEL_URL=https://furtail.app/checkout/cancel
```

---

## Backend Implementation

### 1. Payment Session Creation

When a user initiates checkout, `furtail_api` creates a WPA payment session:

```typescript
// furtail_api/src/payments/wpa-client.ts
import { createHash, createHmac, randomBytes } from 'node:crypto';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(stableJson(v))));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const sorted = Object.keys(value as object).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = JSON.parse(stableJson((value as Record<string, unknown>)[k]));
      return acc;
    }, {});
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

export async function createPaymentSession(params: {
  orderId: string;
  amount: number; // integer, smallest currency unit (e.g. cents)
  currency: string;
  customerName: string;
  customerEmail?: string;
}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');

  const bodyObj: Record<string, unknown> = {
    clientId: process.env.WPA_CLIENT_ID!,
    merchantOrderId: params.orderId,
    amount: params.amount,
    currency: params.currency,
    customerName: params.customerName,
    timestamp,
    nonce,
    successUrl: process.env.FURTAIL_SUCCESS_URL!,
    cancelUrl: process.env.FURTAIL_CANCEL_URL!,
    callbackUrl: process.env.WPA_CALLBACK_URL!,
    webhookUrl: process.env.WPA_WEBHOOK_URL!,
    metadata: null
  };

  if (params.customerEmail) bodyObj.customerEmail = params.customerEmail;

  const canonicalBody = stableJson(bodyObj);
  const bodyHash = createHash('sha256').update(canonicalBody).digest('hex');
  const canonicalString = `POST\n/api/v1/payment-sessions\n${timestamp}\n${bodyHash}`;
  const signature = createHmac('sha256', process.env.WPA_CLIENT_SECRET!)
    .update(canonicalString)
    .digest('hex');

  const response = await fetch(`${process.env.WPA_GATEWAY_URL}/api/v1/payment-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bodyObj, signature })
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(`WPA session creation failed: ${data.error?.message ?? response.status}`);
  }

  return {
    reference: data.session.reference,
    paymentUrl: `${process.env.WPA_GATEWAY_URL}${data.session.paymentUrl}`,
    amount: data.session.amount,
    expiresAt: data.session.expiresAt
  };
}
```

**Usage in order controller:**

```typescript
// When user clicks "Pay"
const session = await createPaymentSession({
  orderId: order.id,
  amount: order.totalCents, // e.g. 4999 for $49.99
  currency: 'USD',
  customerName: user.fullName,
  customerEmail: user.email
});

// Save reference to order for later correlation
await db.order.update({ where: { id: order.id }, data: { wpaReference: session.reference } });

// Redirect user
return res.redirect(session.paymentUrl);
```

### 2. Webhook Handler

```typescript
// furtail_api/src/payments/wpa-webhook.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const router = express.Router();

function verifySignature(rawBody: Buffer, signature: string): boolean {
  const expected = createHmac('sha256', process.env.WPA_CLIENT_SECRET!)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// IMPORTANT: use express.raw — not express.json — for this route
router.post(
  '/payments/wpa/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-gateway-signature'];
    const event = req.headers['x-gateway-event'];

    if (typeof signature !== 'string' || typeof event !== 'string') {
      return res.status(400).json({ error: 'Missing headers' });
    }

    if (!verifySignature(req.body as Buffer, signature)) {
      console.error('[WPA] Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse((req.body as Buffer).toString('utf8')) as {
      event: string;
      merchantOrderId: string;
      gatewayReference: string;
      amount: number;
      currency: string;
      status: string;
      paidAt: string | null;
    };

    // Respond 200 first — process async to avoid timeout
    res.status(200).json({ received: true });

    try {
      switch (payload.event) {
        case 'payment.succeeded':
          await db.order.update({
            where: { id: payload.merchantOrderId },
            data: {
              paymentStatus: 'PAID',
              wpaReference: payload.gatewayReference,
              paidAt: payload.paidAt ? new Date(payload.paidAt) : new Date()
            }
          });
          await sendOrderConfirmationEmail(payload.merchantOrderId);
          break;

        case 'payment.failed':
          await db.order.update({
            where: { id: payload.merchantOrderId },
            data: { paymentStatus: 'FAILED' }
          });
          break;

        case 'payment.cancelled':
          await db.order.update({
            where: { id: payload.merchantOrderId },
            data: { paymentStatus: 'CANCELLED' }
          });
          break;

        default:
          console.log(`[WPA] Unhandled event: ${payload.event}`);
      }
    } catch (err) {
      console.error('[WPA] Error processing webhook:', err);
      // Error is logged — do not re-throw (200 already sent)
    }
  }
);
```

### 3. Success Page (Frontend)

The `successUrl` redirect from the hosted checkout is for **display only**. The page should show status from your backend, not trust any URL parameters.

```typescript
// furtail_app/src/pages/checkout/success.tsx
export default async function SuccessPage() {
  // Read order status from YOUR database — never from URL params
  const order = await getOrderFromDb(session.user.id, latestOrderId);

  if (order.paymentStatus !== 'PAID') {
    return <PaymentPendingMessage />;
  }

  return <OrderConfirmedMessage order={order} />;
}
```

---

## Domain Allowlist Setup

Register these domains in the WPA Admin Panel (Merchants → furtail.app → Domains):

| Domain | Environment | Callback URL | Webhook URL |
|---|---|---|---|
| `furtail.app` | SANDBOX | `https://furtail.app/...` | `https://api.furtail.app/payments/wpa/webhook` |
| `api.furtail.app` | SANDBOX | — | `https://api.furtail.app/payments/wpa/webhook` |
| `localhost` | SANDBOX | — | — |
| `furtail.app` | PRODUCTION | — | `https://api.furtail.app/payments/wpa/webhook` |
| `api.furtail.app` | PRODUCTION | — | `https://api.furtail.app/payments/wpa/webhook` |

---

## Key Security Invariants

| Rule | Implementation |
|---|---|
| `WPA_CLIENT_SECRET` never leaves the backend | Store in env vars, never in frontend bundles |
| Payment session created server-side only | `createPaymentSession()` called from controller, not client |
| Order marked PAID only after signature verification | Webhook handler checks `verifySignature()` before DB write |
| `successUrl` redirect never used as authorization | Success page reads DB, not URL params |
| `merchantOrderId` matches your internal order ID | Allows exact correlation without additional mapping |

---

## Checklist

- [ ] `WPA_CLIENT_ID` and `WPA_CLIENT_SECRET` stored in server environment variables only
- [ ] Webhook endpoint uses `express.raw()` (not `express.json()`) to preserve raw body
- [ ] `verifySignature()` called before any business logic
- [ ] `payment.succeeded` idempotent — check if order already marked PAID
- [ ] Success page reads from database, not from redirect URL parameters
- [ ] `furtail.app` and `api.furtail.app` added to WPA domain allowlist
- [ ] Sandbox credentials used for staging, production credentials for live
- [ ] Webhook endpoint accessible from WPA servers (not behind a firewall or localhost-only)
