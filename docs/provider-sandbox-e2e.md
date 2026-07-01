# Provider Sandbox E2E

This runner verifies real sandbox readiness for:
- `EPS`
- `BKASH`
- `NAGAD`
- `SSLCOMMERZ`

It never uses hardcoded credentials and refuses production-mode execution.

## Safety Guards

Required for any run:
- `PROVIDER_SANDBOX_E2E_ENABLED=true`
- `PROVIDER_SANDBOX_MODE=true`
- `NODE_ENV` must not be `production`

Dry-run mode:
- `--dry-run`
- or `PROVIDER_SANDBOX_E2E_DRY_RUN=true`

## Commands

Run all providers in dry-run mode:

```bash
npx tsx scripts/provider-sandbox-e2e.ts --dry-run
```

Run one provider in dry-run mode:

```bash
npx tsx scripts/provider-sandbox-e2e.ts --dry-run --provider=BKASH
```

Run one provider with real sandbox calls:

```bash
npx tsx scripts/provider-sandbox-e2e.ts --provider=BKASH
```

## Required Env Variables

Common:
- `PROVIDER_SANDBOX_E2E_ENABLED`
- `PROVIDER_SANDBOX_MODE`
- `PROVIDER_SANDBOX_RETURN_URL`
- `PROVIDER_SANDBOX_CALLBACK_URL`

EPS:
- `SANDBOX_EPS_USERNAME`
- `SANDBOX_EPS_PASSWORD`
- `SANDBOX_EPS_HASH_KEY`
- `SANDBOX_EPS_MERCHANT_ID`
- `SANDBOX_EPS_STORE_ID`
- `SANDBOX_EPS_BASE_URL`
- `SANDBOX_EPS_TIMEOUT_MS` optional

BKASH:
- `SANDBOX_BKASH_APP_KEY`
- `SANDBOX_BKASH_APP_SECRET`
- `SANDBOX_BKASH_USERNAME`
- `SANDBOX_BKASH_PASSWORD`
- `SANDBOX_BKASH_BASE_URL`
- `SANDBOX_BKASH_TIMEOUT_MS` optional

NAGAD:
- `SANDBOX_NAGAD_MERCHANT_ID`
- `SANDBOX_NAGAD_PUBLIC_KEY`
- `SANDBOX_NAGAD_PRIVATE_KEY`
- `SANDBOX_NAGAD_BASE_URL`
- `SANDBOX_NAGAD_CALLBACK_URL`
- `SANDBOX_NAGAD_TIMEOUT_MS` optional

SSLCOMMERZ:
- `SANDBOX_SSLCOMMERZ_STORE_ID`
- `SANDBOX_SSLCOMMERZ_STORE_PASSWORD`
- `SANDBOX_SSLCOMMERZ_BASE_URL`
- `SANDBOX_SSLCOMMERZ_IPN_URL`
- `SANDBOX_SSLCOMMERZ_TIMEOUT_MS` optional

## Expected Output

Each provider prints:
- guard result
- credential presence result
- redacted credential summary
- create payment result
- verify payment result
- refund fallback result
- callback/webhook note

## Pass / Fail Rules

Dry-run pass:
- guard flags accepted
- expected env keys are either present or clearly reported missing
- no secret values are printed raw

Live sandbox pass:
- `createPayment` returns a safe normalized result
- `verifyPayment` returns a conservative status
- no secret/token exposure appears in output
- refund path returns `501` / manual-review style fallback when unsupported

Blocked:
- missing sandbox credentials
- sandbox guard flags not enabled
- production mode detected
