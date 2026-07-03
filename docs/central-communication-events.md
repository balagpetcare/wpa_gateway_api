# WPA Gateway - Central Communication Event Trigger

This gateway integration triggers WPA Central Auth communication events only
after a payment has been verified and the local payment/session state has already
been updated.

## Required environment variables

```env
CENTRAL_AUTH_BASE_URL=https://auth.worldpetassociation.com
CENTRAL_COMMUNICATION_API_URL=https://auth.worldpetassociation.com/api/v1/communication/events
CENTRAL_CLIENT_ID=bpa_web_prod
CENTRAL_SERVICE_API_KEY=generated-by-wpa-central-auth
```

## What must not be stored here

- SMTP credentials
- SMS gateway credentials
- OTP secrets
- JWT secrets
- Central Auth database credentials

Only the Central Auth service credential is required for the server-to-server
request.

## When the event is sent

The gateway sends the event after:

1. EPS payment verification succeeds.
2. Local payment/session state is updated.
3. The payment is confirmed as successful.

If the communication call fails, the payment remains successful and the failure is
only logged for later inspection.

## Request contract

The gateway posts a controlled transactional event. The body is built from
approved data already stored in the local payment session.

### Headers

```http
Authorization: Bearer <CENTRAL_SERVICE_API_KEY>
X-Client-Id: <CENTRAL_CLIENT_ID>
Idempotency-Key: payment:<paymentRef>:booking:<bookingRef>
X-Request-Id: <optional correlation id>
Content-Type: application/json
Accept: application/json
```

### Event payload

```json
{
  "event": "VACCINATION_PAYMENT_CONFIRMED",
  "locale": "bn",
  "channels": ["sms", "email"],
  "recipient": {
    "name": "Md Rahim",
    "phone": "01701022274",
    "email": "rahim@example.com"
  },
  "data": {
    "bookingRef": "BPA-VAC-2026-000123",
    "paymentRef": "EPS-TXN-987654",
    "amount": 600,
    "currency": "BDT",
    "campaignName": "BPA Cat Vaccination Campaign 2026",
    "petCount": 1,
    "venueName": "Rampura Venue",
    "sessionDate": "2026-07-10",
    "sessionTime": "10:00 AM - 01:00 PM",
    "bookingSlipUrl": "https://bangladeshpetassociation.com/booking/BPA-VAC-2026-000123",
    "supportPhone": "01701022274"
  }
}
```

## Idempotency

The gateway uses the same idempotency key for duplicate payment callbacks:

`payment:<paymentRef>:booking:<bookingRef>`

That prevents duplicate SMS/email sends when the payment provider retries the
same successful callback.

## BPA backend behavior

- If both phone and email exist, both channels are requested.
- If only phone exists, only SMS is requested.
- If only email exists, only email is requested.
- If both are missing, the communication call is skipped and a safe warning is
  logged.
- The communication response event id is stored in the transaction raw response
  metadata when available.

