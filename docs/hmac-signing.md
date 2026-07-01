# WPA Gateway — HMAC Request Signing

All requests to `POST /api/v1/payment-sessions` must be signed with HMAC-SHA256 using your `clientSecret`. This proves the request originated from your backend and prevents tampering.

---

## Signature Algorithm

### Step 1 — Build the Canonical Body

The canonical body is a **stable JSON string** of all payment fields. Keys are sorted alphabetically at every level before serialization.

Fields included in the canonical body:

```
clientId
merchantOrderId
amount
currency
customerName
customerEmail
customerPhone
description
successUrl
callbackUrl
cancelUrl
webhookUrl
metadata
timestamp
nonce
```

Omitted/undefined optional fields must be excluded from the object (not serialized as `null`), **except `metadata`** — serialize it as `null` if not provided.

Example canonical body (before signing):

```json
{"amount":4999,"callbackUrl":"https://api.furtail.app/wpa/callback","cancelUrl":"https://furtail.app/payments/cancel","clientId":"wpa_test_abc123","currency":"USD","customerEmail":"jane@example.com","customerName":"Jane Doe","customerPhone":"+1 555 010 2400","description":"Premium pet care subscription","merchantOrderId":"order_12345","metadata":null,"nonce":"a1b2c3d4e5f6g7h8","successUrl":"https://furtail.app/payments/success","timestamp":"1751234567","webhookUrl":"https://api.furtail.app/wpa/webhook"}
```

> Keys are sorted alphabetically. **Do not pretty-print.** No spaces, no newlines.

### Step 2 — Build the Canonical String

```
METHOD\nPATH\nTIMESTAMP\nSHA256(canonicalBody)
```

For `POST /api/v1/payment-sessions`:

```
POST\n/api/v1/payment-sessions\n1751234567\n<sha256-hex-of-canonical-body>
```

Where `\n` is a literal newline character (LF, `0x0A`).

### Step 3 — Sign with HMAC-SHA256

```
signature = HMAC-SHA256(canonicalString, clientSecret)
```

Encode the result as a **lowercase hex string**.

---

## Timestamp and Nonce Rules

| Field | Requirement |
|---|---|
| `timestamp` | Unix epoch seconds as a string. Must be within ±300 seconds of the gateway server time. |
| `nonce` | Random string, 12–128 characters. Must be unique within a 10-minute window per merchant. |

Generate a nonce with sufficient entropy:

```javascript
import { randomBytes } from 'node:crypto';
const nonce = randomBytes(16).toString('hex'); // 32 hex chars
```

---

## TypeScript Reference Implementation

```typescript
import { createHash, createHmac } from 'node:crypto';

/** Recursively sort object keys alphabetically (stable JSON). */
function normalizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForJson);
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeForJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function buildCanonicalString(params: {
  method: string;
  path: string;
  timestamp: string;
  canonicalBody: string;
}): string {
  return [
    params.method.toUpperCase(),
    params.path,
    params.timestamp,
    sha256Hex(params.canonicalBody)
  ].join('\n');
}

export function createPaymentSessionSignature(params: {
  clientId: string;
  merchantOrderId: string;
  amount: number;
  currency: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  description?: string;
  successUrl: string;
  callbackUrl: string;
  cancelUrl?: string;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  nonce: string;
  clientSecret: string;
}): string {
  const bodyObject: Record<string, unknown> = {
    clientId: params.clientId,
    merchantOrderId: params.merchantOrderId,
    amount: params.amount,
    currency: params.currency,
    customerName: params.customerName,
    timestamp: params.timestamp,
    nonce: params.nonce,
    successUrl: params.successUrl,
    callbackUrl: params.callbackUrl,
    metadata: params.metadata ?? null
  };

  if (params.customerEmail) bodyObject.customerEmail = params.customerEmail;
  if (params.customerPhone) bodyObject.customerPhone = params.customerPhone;
  if (params.description)   bodyObject.description   = params.description;
  if (params.cancelUrl)     bodyObject.cancelUrl     = params.cancelUrl;
  if (params.webhookUrl)    bodyObject.webhookUrl    = params.webhookUrl;

  const canonicalBody = stableJsonStringify(bodyObject);
  const canonicalString = buildCanonicalString({
    method: 'POST',
    path: '/api/v1/payment-sessions',
    timestamp: params.timestamp,
    canonicalBody
  });

  return createHmac('sha256', params.clientSecret)
    .update(canonicalString)
    .digest('hex');
}
```

---

## Python Reference

```python
import hashlib
import hmac
import json
import time
import secrets

def stable_json(obj):
    """Recursively sort dict keys and serialize to compact JSON."""
    if isinstance(obj, dict):
        return json.dumps(
            {k: json.loads(stable_json(v)) for k, v in sorted(obj.items())},
            separators=(',', ':')
        )
    if isinstance(obj, list):
        return json.dumps([json.loads(stable_json(i)) for i in obj], separators=(',', ':'))
    return json.dumps(obj, separators=(',', ':'))

def sha256_hex(payload: str) -> str:
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()

def create_payment_session_signature(params: dict, client_secret: str) -> str:
    body_obj = {
        'clientId': params['clientId'],
        'merchantOrderId': params['merchantOrderId'],
        'amount': params['amount'],
        'currency': params['currency'],
        'customerName': params['customerName'],
        'timestamp': params['timestamp'],
        'nonce': params['nonce'],
        'successUrl': params['successUrl'],
        'callbackUrl': params['callbackUrl'],
        'metadata': params.get('metadata') or None,
    }
    for optional in ('customerEmail', 'customerPhone', 'description', 'cancelUrl', 'webhookUrl'):
        if params.get(optional):
            body_obj[optional] = params[optional]

    canonical_body = stable_json(body_obj)
    body_hash = sha256_hex(canonical_body)
    canonical_string = f"POST\n/api/v1/payment-sessions\n{params['timestamp']}\n{body_hash}"

    return hmac.new(
        client_secret.encode('utf-8'),
        canonical_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
```

---

## Common Mistakes

| Mistake | Effect |
|---|---|
| Including `undefined` fields in the JSON | Signature mismatch — omit optional fields entirely if not set |
| Using `null` for `metadata` when it IS provided | Signature mismatch |
| Pretty-printing the canonical JSON | Signature mismatch |
| Using milliseconds instead of seconds for timestamp | `TIMESTAMP_EXPIRED` error |
| Reusing a nonce within 10 minutes | `REPLAY_DETECTED` error |
| Using the wrong path (e.g., `/payment-sessions` without `/api/v1`) | Signature mismatch |
| Signing with clientId instead of clientSecret | Signature mismatch |
