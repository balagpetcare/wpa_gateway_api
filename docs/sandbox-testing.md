# WPA Gateway — Sandbox Testing Guide

## Overview

The sandbox environment lets you test the full payment flow without real money. Sandbox and production are logically separate — each API key is scoped to one environment.

---

## Sandbox vs Production

| | Sandbox | Production |
|---|---|---|
| API key prefix | `wpa_test_` / `wpa_secret_test_` | `wpa_live_` / `wpa_secret_live_` |
| Payments charged | No | Yes |
| Provider | Mock EPS sandbox adapter | Real payment provider |
| Callback delivery | Real HTTP POST to your server | Real HTTP POST to your server |
| Domain allowlist | Enforced | Enforced |
| HMAC signing | Required (same algorithm) | Required (same algorithm) |

> **Tip:** Sandbox and production require separate API keys. A `wpa_test_` key cannot create production sessions, and vice versa.

---

## Local Dev Setup

### 1. Install and configure

```bash
# Copy the example env file
cp .env.example .env

# Fill in your local values
WPA_GATEWAY_URL=http://localhost:4000
WPA_CLIENT_ID=wpa_test_...
WPA_CLIENT_SECRET=wpa_secret_test_...
```

### 2. Get sandbox credentials

1. Start the API: `npm run dev`
2. Log in to the Admin Panel (`http://localhost:3000`).
3. Navigate to **Merchants → furtail.app → API Keys**.
4. Click **Create API Key**, choose **SANDBOX**.
5. Copy the `clientId` and `clientSecret` — they appear once.
6. Add them to your `.env` file.

### 3. Run the example script

```bash
cd examples/node
npx tsx create-payment-session.ts
```

---

## Seeded Test Data

After `npm run seed`, the following data exists in the local database:

| Resource | Value |
|---|---|
| Admin email | `admin@worldpetsassociation.com` |
| Admin password | `WpaAdmin123!` |
| Test merchant | `furtail.app` |
| Merchant contact email | `payments@furtail.app` |
| Merchant environment | SANDBOX |
| Allowed domains | `furtail.app`, `api.furtail.app`, `localhost`, `127.0.0.1`, `worldpetsassociation.com`, `pay.worldpetsassociation.com` |

> **Note:** The seeded API key credentials are rotated on each `npm run seed`. Retrieve the current `clientId`/`clientSecret` from the Admin Panel after seeding.

---

## Test Scenarios

### Successful payment

1. Create a session with a valid `merchantOrderId`.
2. Visit the `paymentUrl` in your browser.
3. Choose the available provider and confirm payment.
4. Your `webhookUrl` will receive `{ "event": "payment.succeeded" }`.

### Expired timestamp

Set `timestamp` to a value more than 300 seconds in the past:

```typescript
const timestamp = String(Math.floor(Date.now() / 1000) - 400);
```

Expected response: `401 TIMESTAMP_EXPIRED`

### Replayed nonce

Use the same `nonce` in two requests within 10 minutes.

Expected response on the second: `401 REPLAY_DETECTED`

### Invalid signature

Change any field in the body after computing the signature:

```typescript
const body = buildPaymentBody({ ..., amount: 4999 });
body.amount = 9999; // tamper after signing
```

Expected response: `401 INVALID_SIGNATURE`

### Duplicate order (same details, pending)

Submit the same `merchantOrderId` twice with identical fields.

Expected: Second call returns `200` with the existing session (idempotent).

### Duplicate order (different amount)

Submit the same `merchantOrderId` with a different `amount`.

Expected: `409 CONFLICT — Duplicate merchantOrderId with different payment details`

### Domain not allowed

Use a `callbackUrl` with a hostname not in the domain allowlist.

Expected: `403 DOMAIN_NOT_ALLOWED`

### Currency not supported

Use a currency not configured for any active provider (e.g., `ZZZ`).

Expected: `422 UNSUPPORTED_CURRENCY`

### Webhook signature tampering test

Send your webhook endpoint a POST with a valid payload but a modified `x-gateway-signature`:

```bash
curl -X POST http://localhost:3001/wpa/webhook \
  -H 'content-type: application/json' \
  -H 'x-gateway-event: payment.succeeded' \
  -H 'x-gateway-timestamp: 1751234567' \
  -H 'x-gateway-nonce: aabbccddeeff00112233' \
  -H 'x-gateway-signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"event":"payment.succeeded","merchantOrderId":"order_test","amount":4999,"currency":"USD",...}'
```

Your endpoint should return `401` and log a warning. This verifies your verification code rejects tampered payloads.

---

## Inspecting Callbacks

The Admin Panel shows all callback delivery attempts under **Callback Logs**. Each entry shows:
- Target URL
- Request headers and body (with `x-gateway-signature`)
- Response code and body
- Delivery status and retry schedule

Use this to debug webhook delivery without needing a public URL during development.

---

## Local Webhook Testing with ngrok

To receive webhooks on `localhost` during development:

```bash
# Install ngrok (https://ngrok.com)
ngrok http 3001

# Use the HTTPS tunnel URL as your webhookUrl:
# https://abc123.ngrok.io/wpa/webhook
```

Add `abc123.ngrok.io` to your merchant's allowed domains in the Admin Panel.

---

## Clock Skew

The gateway rejects timestamps outside ±300 seconds of server time. If you see `TIMESTAMP_EXPIRED` errors during local testing, verify:

```bash
# Check your system clock
date -u

# The timestamp you're sending
node -e "console.log(Math.floor(Date.now()/1000))"
```
