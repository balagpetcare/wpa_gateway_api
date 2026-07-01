# WPA Gateway — Error Codes

All error responses use this format:

```json
{
  "error": {
    "code": "INVALID_SIGNATURE",
    "message": "HMAC signature verification failed",
    "statusCode": 401
  }
}
```

For validation errors, a `details` object may be included:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "statusCode": 400,
    "details": {
      "fieldErrors": {
        "amount": ["Expected number, received string"]
      }
    }
  }
}
```

---

## Error Code Reference

### Authentication Errors (401)

| Code | Meaning | Fix |
|---|---|---|
| `INVALID_SIGNATURE` | HMAC signature does not match | Verify signing algorithm, key order, canonical body format |
| `TIMESTAMP_EXPIRED` | `timestamp` is outside the ±300s window | Sync your server clock; use Unix seconds, not milliseconds |
| `REPLAY_DETECTED` | Nonce has been used within the last 10 minutes | Generate a fresh nonce per request |
| `KEY_REVOKED` | API key has been revoked | Rotate to a new API key via Admin Panel |
| `KEY_EXPIRED` | API key has passed its expiry date | Create a new API key via Admin Panel |

### Authorization Errors (403)

| Code | Meaning | Fix |
|---|---|---|
| `MERCHANT_INACTIVE` | Merchant account is suspended or inactive | Contact WPA admin |
| `DOMAIN_NOT_ALLOWED` | `callbackUrl` or `webhookUrl` host is not in merchant allowlist | Add domain via Admin Panel → Merchants → Domains |

### Not Found (404)

| Code | Meaning |
|---|---|
| `SESSION_NOT_FOUND` | No checkout session with that `reference`, or session expired |

### Conflict (409)

| Code | Meaning | Fix |
|---|---|---|
| `CONFLICT` | `merchantOrderId` already exists with different details, or in a non-pending state | Use a new `merchantOrderId` for a new order attempt |

### Validation Errors (400)

| Code | Meaning |
|---|---|
| `VALIDATION_ERROR` | One or more request fields failed validation. Check `details.fieldErrors` |

### Business Logic Errors (410, 422)

| Code | HTTP | Meaning |
|---|---|---|
| `SESSION_NOT_FOUND` | 410 | Checkout session exists but is no longer available (expired, paid, cancelled) |
| `UNSUPPORTED_CURRENCY` | 422 | Currency not supported by any active provider for this merchant |
| `PROVIDER_NOT_CONFIGURED` | 422 | No provider matches the selected `providerCode` |

### Provider Errors (502, 503)

| Code | HTTP | Meaning |
|---|---|---|
| `PROVIDER_NOT_CONFIGURED` | 503 | Provider is active but has no credentials configured |
| `PROVIDER_ERROR` | 502 | Provider returned an unexpected error |
| `PROVIDER_TIMEOUT` | 502 | Provider request timed out |
| `PROVIDER_UNAVAILABLE` | 503 | Provider is temporarily unavailable |

### Rate Limiting (429)

| Code | HTTP | Meaning |
|---|---|---|
| `FORBIDDEN` | 429 | Too many requests. Back off and retry after the window resets |

Rate limits per endpoint:
- `POST /api/v1/payment-sessions` — 30 req/min per IP
- `GET /api/v1/checkout/:reference` — 60 req/min per IP
- `GET /api/v1/checkout/:reference/status` — 120 req/min per IP
- `POST /api/v1/checkout/:reference/pay` — 30 req/min per IP

---

## Retry Strategy

| Condition | Retry? |
|---|---|
| `INVALID_SIGNATURE` | No — fix signing code |
| `TIMESTAMP_EXPIRED` | Yes — regenerate timestamp and nonce, re-sign |
| `REPLAY_DETECTED` | Yes — generate a fresh nonce |
| `VALIDATION_ERROR` | No — fix request payload |
| `CONFLICT` (duplicate order) | No — inspect existing session |
| `PROVIDER_ERROR` / `PROVIDER_TIMEOUT` | Yes — exponential backoff, up to 3 retries |
| `429` | Yes — respect `Retry-After` header if present |

---

## Idempotent Retry on Network Failure

If you receive a network timeout or `5xx` error after submitting `POST /api/v1/payment-sessions`, retry with the **exact same** `merchantOrderId`, `amount`, `currency`, and all other fields. The gateway will return the existing pending session (HTTP 200) instead of creating a duplicate.

Regenerate `timestamp`, `nonce`, and `signature` for each retry attempt.
