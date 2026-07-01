# WPA Gateway — cURL Examples

Replace all placeholder values (`$CLIENT_ID`, `$CLIENT_SECRET`, etc.) with real values before running.

---

## Prerequisites

The HMAC signature must be computed server-side. These examples use a small shell helper that requires `openssl` and `jq`.

### Shell signing helper

Save as `sign.sh`:

```bash
#!/usr/bin/env bash
# sign.sh — Compute WPA HMAC-SHA256 payment session signature
# Usage: bash sign.sh <canonical_body> <timestamp> <client_secret>

CANONICAL_BODY="$1"
TIMESTAMP="$2"
CLIENT_SECRET="$3"

BODY_HASH=$(printf '%s' "$CANONICAL_BODY" | openssl dgst -sha256 | awk '{print $2}')
CANONICAL_STRING="POST\n/api/v1/payment-sessions\n${TIMESTAMP}\n${BODY_HASH}"

printf '%s' "$CANONICAL_STRING" | openssl dgst -sha256 -hmac "$CLIENT_SECRET" | awk '{print $2}'
```

> In production, use the TypeScript/Python SDK rather than shell scripting for signing.

---

## Create a Payment Session

```bash
#!/usr/bin/env bash

GATEWAY_URL="http://localhost:4000"
CLIENT_ID="wpa_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
CLIENT_SECRET="wpa_secret_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
ORDER_ID="order_curl_$(date +%s)"

TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

# Build canonical body (keys sorted alphabetically, no extra whitespace)
# IMPORTANT: Key order here must be exactly alphabetical after sorting
CANONICAL_BODY=$(jq -cn --arg cid "$CLIENT_ID" \
                         --arg oid "$ORDER_ID" \
                         --argjson amt 4999 \
                         --arg cur "USD" \
                         --arg name "Jane Doe" \
                         --arg email "jane@example.com" \
                         --arg cb "https://furtail.app/wpa/callback" \
                         --arg su "https://furtail.app/payments/success" \
                         --arg ts "$TIMESTAMP" \
                         --arg nonce "$NONCE" \
  '{
    callbackUrl: $cb,
    clientId: $cid,
    currency: $cur,
    customerEmail: $email,
    customerName: $name,
    amount: $amt,
    merchantOrderId: $oid,
    metadata: null,
    nonce: $nonce,
    successUrl: $su,
    timestamp: $ts
  } | to_entries | sort_by(.key) | from_entries')

BODY_HASH=$(printf '%s' "$CANONICAL_BODY" | openssl dgst -sha256 | awk '{print $2}')
CANONICAL_STRING="POST\n/api/v1/payment-sessions\n${TIMESTAMP}\n${BODY_HASH}"
SIGNATURE=$(printf '%b' "$CANONICAL_STRING" | openssl dgst -sha256 -hmac "$CLIENT_SECRET" | awk '{print $2}')

# Build final request body (add signature field)
REQUEST_BODY=$(echo "$CANONICAL_BODY" | jq --arg sig "$SIGNATURE" '. + {signature: $sig}')

echo "Request body:"
echo "$REQUEST_BODY" | jq .
echo ""

curl -s -X POST "$GATEWAY_URL/api/v1/payment-sessions" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY" | jq .
```

---

## Get Checkout Status (no auth required)

```bash
GATEWAY_URL="http://localhost:4000"
REFERENCE="wps_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"

curl -s "$GATEWAY_URL/api/v1/checkout/$REFERENCE/status" | jq .
```

Expected response:
```json
{
  "success": true,
  "session": {
    "reference": "wps_a1b2c3d4...",
    "status": "PENDING",
    "transactionStatus": null,
    "amount": 4999,
    "currency": "USD",
    "merchantOrderId": "order_curl_...",
    "updatedAt": "2026-06-29T15:00:00.000Z"
  }
}
```

---

## Get Checkout Session Details (no auth required)

```bash
curl -s "$GATEWAY_URL/api/v1/checkout/$REFERENCE" | jq .
```

---

## Test Webhook Verification (simulate a gateway callback)

```bash
GATEWAY_URL="http://localhost:4000"
CLIENT_SECRET="wpa_secret_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
YOUR_WEBHOOK_URL="http://localhost:3001/wpa/webhook"

TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 12)

PAYLOAD=$(jq -cn \
  --arg event "payment.succeeded" \
  --arg oid "order_curl_test" \
  --arg ref "wps_a1b2c3d4e5f6g7h8" \
  --argjson amt 4999 \
  --arg cur "USD" \
  --arg status "SUCCESS" \
  --arg paid "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson ts "$TIMESTAMP" \
  --arg nonce "$NONCE" \
  '{
    amount: $amt,
    currency: $cur,
    event: $event,
    gatewayReference: $ref,
    merchantOrderId: $oid,
    nonce: $nonce,
    paidAt: $paid,
    status: $status,
    timestamp: $ts,
    transactionReference: null
  } | to_entries | sort_by(.key) | from_entries')

# The gateway sends stableJsonStringify — same as jq's compact output with sorted keys
SIGNATURE=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$CLIENT_SECRET" | awk '{print $2}')

curl -s -X POST "$YOUR_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-gateway-event: payment.succeeded" \
  -H "x-gateway-timestamp: $TIMESTAMP" \
  -H "x-gateway-nonce: $NONCE" \
  -H "x-gateway-signature: $SIGNATURE" \
  -d "$PAYLOAD" | jq .
```

---

## Trigger Error Scenarios

### Test TIMESTAMP_EXPIRED

```bash
OLD_TIMESTAMP=$(($(date +%s) - 400))  # 400 seconds in the past

# Use OLD_TIMESTAMP in the canonical body and signature, then send:
curl -s -X POST "$GATEWAY_URL/api/v1/payment-sessions" \
  -H "Content-Type: application/json" \
  -d '{ "clientId": "...", "timestamp": "'$OLD_TIMESTAMP'", ... }' | jq .
# → 401 TIMESTAMP_EXPIRED
```

### Test VALIDATION_ERROR

```bash
curl -s -X POST "$GATEWAY_URL/api/v1/payment-sessions" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"test","merchantOrderId":"order_1"}' | jq .
# → 400 VALIDATION_ERROR (missing required fields)
```
