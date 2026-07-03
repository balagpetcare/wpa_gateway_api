# WPA Payment Gateway — Merchant Integration Guide

## Overview

The WPA Payment Gateway provides a secure, HMAC-authenticated API for merchants to initiate payment sessions and receive real-time payment notifications. This guide covers the complete integration flow.

---

## Prerequisites

1. **Merchant account** — created by a WPA admin.
2. **API credentials** — `clientId` and `clientSecret` generated from the Admin Panel under **Merchants → [Your Merchant] → API Keys**.
3. **Allowed domains** — at least one domain registered under **Merchants → [Your Merchant] → Domains** that matches your `callbackUrl`/`webhookUrl` hostnames.
4. **Backend server** — payment sessions must be created server-side. Never call the WPA API from a browser or mobile app.

---

## Security Warnings

> **Critical — read before integrating:**

- **Never expose `clientSecret` in frontend code, mobile apps, or public repositories.** It must live only on your backend server.
- **Always create payment sessions from your backend.** The `clientSecret` must sign every request.
- **Never trust the frontend return URL alone to mark a payment as successful.** Always wait for the signed webhook notification before updating your order state.
- **Always verify `x-gateway-signature` before processing any webhook.** Ignore unsigned or tampered notifications.

---

## Integration Flow

```
Your Backend                  WPA Gateway                 Payment Provider
     |                             |                              |
     |-- POST /api/v1/payment-sessions ——→|                      |
     |←── { paymentUrl, reference } ——   |                      |
     |                             |                              |
     | (redirect customer to paymentUrl)  |                      |
     |                             |                              |
     |               Customer visits /checkout/{reference}       |
     |                             |-- createPayment() ─────────→|
     |                             |←── providerPaymentUrl ──────|
     |                             |                              |
     |               Customer completes payment                  |
     |                             |←── webhook ────────────────|
     |                             |  (processProviderWebhook)   |
     |←── POST {webhookUrl} ───────|                             |
     | (x-gateway-signature header)|                             |
     |                             |                              |
     | Verify signature            |                              |
     | Update order status         |                              |
     | Return HTTP 200             |                              |
```

---

## Step 1 — Create Merchant Credentials

1. Log in to the WPA Admin Panel.
2. Navigate to **Merchants** and open your merchant record.
3. Go to the **API Keys** tab.
4. Click **Create API Key**, choose **SANDBOX** or **PRODUCTION**, add a label.
5. Copy the `clientId` and `clientSecret` immediately — the secret is shown only once.
6. Store them in environment variables on your backend server:

```env
WPA_CLIENT_ID=wpa_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
WPA_CLIENT_SECRET=wpa_secret_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WPA_GATEWAY_URL=https://gateway.worldpetsassociation.com
```

---

## Step 2 — Register Allowed Domains

Your `callbackUrl` and `webhookUrl` must point to a domain registered in the Admin Panel.

1. Navigate to **Merchants → [Your Merchant] → Domains**.
2. Click **Add Domain**.
3. Enter your hostname (e.g., `furtail.app` or `https://api.furtail.app`).
4. Add callback and webhook URL patterns.
5. Set environment to **SANDBOX** for testing, **PRODUCTION** for live.

---

## Step 3 — Create a Payment Session

Call `POST /api/v1/payment-sessions` from your backend server:

```http
POST /api/v1/payment-sessions
Content-Type: application/json

{
  "clientId": "wpa_test_...",
  "merchantOrderId": "order_12345",
  "amount": 4999,
  "currency": "USD",
  "customerName": "Jane Doe",
  "customerEmail": "jane@example.com",
  "customerPhone": "+1 555 010 2400",
  "description": "Premium pet care subscription",
  "successUrl": "https://furtail.app/payments/success",
  "cancelUrl": "https://furtail.app/payments/cancel",
  "callbackUrl": "https://api.furtail.app/wpa/callback",
  "webhookUrl": "https://api.furtail.app/wpa/webhook",
  "metadata": { "userId": "usr_789", "plan": "premium" },
  "timestamp": "1751234567",
  "nonce": "a1b2c3d4e5f6g7h8",
  "signature": "abc123..."
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `clientId` | string | ✅ | Your API key client ID |
| `merchantOrderId` | string (max 100) | ✅ | Your internal order ID — idempotency key |
| `amount` | integer | ✅ | Amount in smallest currency unit (e.g., cents for USD) |
| `currency` | string (3 chars) | ✅ | ISO 4217 currency code (e.g., `USD`) |
| `customerName` | string (max 120) | ✅ | Customer full name |
| `customerEmail` | email | ❌ | Customer email |
| `customerPhone` | string | ❌ | Customer phone, format: `+1 555 010 2400` |
| `description` | string (max 255) | ❌ | Payment description shown on checkout |
| `successUrl` | URL | ✅ | Redirect URL after successful payment |
| `cancelUrl` | URL | ❌ | Redirect URL if customer cancels |
| `callbackUrl` | URL | ✅ | Receives signed payment status notification |
| `webhookUrl` | URL | ❌ | Secondary webhook URL (preferred over callbackUrl if set) |
| `metadata` | object | ❌ | Arbitrary key/value data echoed back in callback |
| `timestamp` | string | ✅ | Unix seconds as string. Must be within ±300s of server time |
| `nonce` | string (12–128 chars) | ✅ | Unique random value — prevents replay attacks |
| `signature` | string | ✅ | HMAC-SHA256 hex signature. See [hmac-signing.md](./hmac-signing.md) |

> **Amount precision:** All amounts are integers in the smallest currency unit. `4999` = $49.99 USD.

### Vaccination booking metadata contract

For BPA vaccination campaigns, include these metadata fields in the payment
session request so the downstream Central Auth communication event can send the
post-payment SMS/email:

- `bookingRef`
- `campaignName`
- `bookingSlipUrl`
- `petCount`
- `venueName`
- `sessionDate`
- `sessionTime`
- `supportPhone`

Recommended production setup:

```env
PUBLIC_SITE_URL=https://bangladeshpetassociation.com
```

The booking slip URL should be a public BPA site URL, for example:

`https://bangladeshpetassociation.com/booking/BPA-VAC-2026-000123`

### Success Response (HTTP 201)

```json
{
  "success": true,
  "session": {
    "id": "cm...",
    "reference": "wps_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "status": "PENDING",
    "amount": 4999,
    "currency": "USD",
    "merchantOrderId": "order_12345",
    "paymentUrl": "/checkout/wps_a1b2c3d4...",
    "expiresAt": "2026-06-29T16:00:00.000Z"
  }
}
```

### Idempotent Retry (HTTP 200)

If you submit the same `merchantOrderId` with identical payment details and the session is still `PENDING`, you receive the existing session (HTTP 200). This allows safe retry on network failure.

If the same `merchantOrderId` exists with **different** payment details or in a non-pending state, the gateway returns **HTTP 409 CONFLICT**.

---

## Step 4 — Redirect Customer to paymentUrl

The `paymentUrl` is a relative path. Prepend the gateway base URL:

```
https://gateway.worldpetsassociation.com/checkout/wps_a1b2c3d4...
```

Redirect the customer's browser to this URL, or open it in a WebView.

The hosted checkout page:
- Displays merchant name, amount, currency, and description.
- Lists available payment providers for the customer to choose.
- Handles the entire payment flow with the selected provider.
- Redirects to your `successUrl` or `cancelUrl` when done.

Sessions expire **60 minutes** after creation.

---

## Step 5 — Poll Checkout Status (Optional)

You can poll session status for frontend display. This is **not** authoritative for order updates — use the webhook for that.

```http
GET /api/v1/checkout/wps_a1b2c3d4.../status
```

Response:
```json
{
  "success": true,
  "session": {
    "reference": "wps_a1b2c3d4...",
    "status": "PENDING",
    "transactionStatus": null,
    "amount": 4999,
    "currency": "USD",
    "merchantOrderId": "order_12345",
    "updatedAt": "2026-06-29T15:00:00.000Z"
  }
}
```

Session statuses: `PENDING`, `SUCCESS`, `FAILED`, `EXPIRED`, `CANCELLED`

---

## Step 6 — Receive and Verify the Webhook

When payment completes (success, failure, or cancellation), WPA sends a signed HTTP POST to your `webhookUrl` (or `callbackUrl`).

See [webhook-verification.md](./webhook-verification.md) for the complete verification guide.

Quick reference:

```javascript
import { createHmac } from 'node:crypto';

function verifyGatewayWebhook(rawBody, clientSecret, receivedSignature) {
  const expected = createHmac('sha256', clientSecret)
    .update(rawBody)
    .digest('hex');
  return expected === receivedSignature;
}
```

### Webhook Events

| Event | Meaning |
|---|---|
| `payment.succeeded` | Payment confirmed. Safe to fulfill order. |
| `payment.failed` | Payment failed. Do not fulfill. |
| `payment.cancelled` | Customer cancelled. Do not fulfill. |
| `payment.pending` | Intermediate state (rarely delivered). |

---

## Handling Errors

See [error-codes.md](./error-codes.md) for the full error reference.

Always check the HTTP status code first. Error responses follow this format:

```json
{
  "error": {
    "code": "INVALID_SIGNATURE",
    "message": "HMAC signature verification failed",
    "statusCode": 401
  }
}
```

---

## Sandbox vs Production

See [sandbox-testing.md](./sandbox-testing.md) for sandbox behavior and test scenarios.

Key differences:
- Sandbox API keys start with `wpa_test_` and `wpa_secret_test_`.
- Production API keys start with `wpa_live_` and `wpa_secret_live_`.
- Sandbox payments use mock provider flows and do not charge real money.
- Each API key is scoped to one environment — a sandbox key cannot create production sessions.

---

## Runnable Examples

See the `examples/` directory:

- [`examples/node/create-payment-session.ts`](../examples/node/create-payment-session.ts) — Creates a payment session and prints the checkout URL
- [`examples/node/verify-webhook.ts`](../examples/node/verify-webhook.ts) — Verifies and decodes a gateway callback
- [`examples/node/server-example.ts`](../examples/node/server-example.ts) — Minimal Node.js HTTP server with full integration flow
- [`examples/curl/create-payment-session.md`](../examples/curl/create-payment-session.md) — cURL commands

---

## SDK Helper

A zero-dependency TypeScript helper is available in `examples/node/wpa-sdk.ts`:

```typescript
import {
  createPaymentSessionSignature,
  verifyGatewayWebhook,
  buildPaymentSessionBody
} from './wpa-sdk.js';
```
