# WPA Gateway — Webhook Verification

When a payment completes, the WPA Gateway sends a signed HTTP POST to your `webhookUrl` (preferred) or `callbackUrl`. You must verify the signature before acting on the notification.

---

## Delivery Headers

Every gateway callback includes these headers:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-gateway-timestamp` | Unix epoch seconds (string) |
| `x-gateway-nonce` | 24-character hex random string |
| `x-gateway-event` | `payment.succeeded`, `payment.failed`, `payment.cancelled`, or `payment.pending` |
| `x-gateway-signature` | HMAC-SHA256 hex signature of the request body |

---

## Callback Payload

The request body is a compact JSON string (no extra whitespace) with keys sorted alphabetically:

```json
{
  "amount": 4999,
  "currency": "USD",
  "event": "payment.succeeded",
  "gatewayReference": "wps_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "merchantOrderId": "order_12345",
  "nonce": "a1b2c3d4e5f6g7h8i9j0k1l2",
  "paidAt": "2026-06-29T15:30:00.000Z",
  "status": "SUCCESS",
  "timestamp": 1751234567,
  "transactionReference": "eps_txn_abc123"
}
```

| Field | Description |
|---|---|
| `event` | `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.pending` |
| `merchantOrderId` | Your original order ID from the session creation request |
| `gatewayReference` | WPA gateway session reference (`wps_...`) |
| `transactionReference` | Provider transaction reference (may be `null`) |
| `amount` | Integer — same value sent during session creation |
| `currency` | ISO 4217 currency code |
| `status` | `SUCCESS`, `FAILED`, `CANCELLED`, or `PENDING` |
| `paidAt` | ISO 8601 timestamp of payment, or `null` if not succeeded |
| `timestamp` | Unix seconds when the callback was dispatched |
| `nonce` | Random 24-char hex — for replay detection on your end |

---

## Signature Verification

The signature is `HMAC-SHA256(rawRequestBody, clientSecret)` encoded as a lowercase hex string.

**Critical:** Use the **raw request body bytes** — do not parse and re-serialize the JSON. Differences in key ordering or whitespace will cause a mismatch.

### Node.js Verification

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an incoming WPA gateway webhook.
 *
 * @param rawBody   - Raw request body buffer/string (do not JSON.parse first)
 * @param clientSecret - Your WPA API key client secret
 * @param signature    - Value of x-gateway-signature header
 * @returns true if signature is valid
 */
export function verifyGatewayWebhook(
  rawBody: string | Buffer,
  clientSecret: string,
  signature: string
): boolean {
  const expected = createHmac('sha256', clientSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(signature, 'hex');

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}
```

### Express.js Webhook Endpoint

```typescript
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();

// IMPORTANT: Use express.raw() — not express.json() — for webhook routes.
// express.json() discards the raw body needed for signature verification.
app.post(
  '/wpa/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['x-gateway-signature'];
    const event = req.headers['x-gateway-event'];
    const rawBody = req.body; // Buffer

    if (typeof signature !== 'string' || typeof event !== 'string') {
      return res.status(400).json({ error: 'Missing gateway headers' });
    }

    const isValid = verifyGatewayWebhook(rawBody, process.env.WPA_CLIENT_SECRET!, signature);
    if (!isValid) {
      console.warn('WPA webhook signature verification FAILED');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(rawBody.toString('utf8'));

    switch (payload.event) {
      case 'payment.succeeded':
        // Safe to fulfill order
        console.log(`Order ${payload.merchantOrderId} paid — ${payload.amount} ${payload.currency}`);
        fulfillOrder(payload.merchantOrderId, payload.gatewayReference);
        break;

      case 'payment.failed':
        console.log(`Order ${payload.merchantOrderId} failed`);
        markOrderFailed(payload.merchantOrderId);
        break;

      case 'payment.cancelled':
        console.log(`Order ${payload.merchantOrderId} cancelled`);
        markOrderCancelled(payload.merchantOrderId);
        break;

      default:
        console.log(`Unhandled event: ${payload.event}`);
    }

    // Respond 200 quickly. Retry logic is on the gateway side.
    res.status(200).json({ received: true });
  }
);
```

### Python Verification

```python
import hashlib
import hmac

def verify_gateway_webhook(raw_body: bytes, client_secret: str, signature: str) -> bool:
    """
    Verify an incoming WPA gateway webhook signature.
    raw_body must be the raw request body bytes (before any JSON parsing).
    """
    expected = hmac.new(
        client_secret.encode('utf-8'),
        raw_body,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

---

## Replay Protection

The payload contains `timestamp` and `nonce` so you can implement your own replay protection:

```typescript
const TOLERANCE_SECONDS = 300; // 5 minutes

function isTimestampFresh(timestamp: number): boolean {
  return Math.abs(Date.now() / 1000 - timestamp) <= TOLERANCE_SECONDS;
}

// Track seen nonces in Redis or a similar store
async function isNonceSeen(nonce: string): Promise<boolean> {
  const key = `wpa_nonce:${nonce}`;
  const exists = await redis.exists(key);
  if (!exists) {
    await redis.setex(key, TOLERANCE_SECONDS * 2, '1');
  }
  return exists === 1;
}
```

---

## Retry Behavior

If your endpoint returns anything other than HTTP 2xx, the gateway schedules one retry after **15 minutes**. Your endpoint should:

1. Respond **HTTP 200** immediately after signature verification.
2. Perform order updates asynchronously if they take time.
3. Handle duplicate deliveries — callbacks may be delivered more than once. Use `merchantOrderId` + `gatewayReference` as an idempotency key.

---

## Event Handling Rules

| Rule | Detail |
|---|---|
| Only `payment.succeeded` authorizes fulfillment | Never fulfill on `payment.pending` |
| Idempotent by `merchantOrderId` | Ignore a `payment.succeeded` if order already fulfilled |
| Do not rely on `successUrl` redirect | Browser redirects can be intercepted or skipped |
| `status` is the authoritative field | `event` and `status` always agree — use either |
| `paidAt` is set only on `payment.succeeded` | Null otherwise |
