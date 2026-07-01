import 'dotenv/config';
import { ApiError } from '../src/utils/errors.js';
import { EPSProviderAdapter } from '../src/providers/eps.js';
import { BKASHProviderAdapter } from '../src/providers/bkash.js';
import { NAGADProviderAdapter } from '../src/providers/nagad.js';
import { SSLCOMMERZProviderAdapter } from '../src/providers/sslcommerz.js';
import type { PaymentProviderAdapter, ProviderCredentials } from '../src/providers/base.js';

type ProviderCode = 'EPS' | 'BKASH' | 'NAGAD' | 'SSLCOMMERZ';

type ProviderEnvConfig = {
  code: ProviderCode;
  adapter: PaymentProviderAdapter;
  requiredEnvKeys: string[];
  buildCredentials: () => ProviderCredentials;
};

type ProviderRunResult = {
  provider: ProviderCode;
  mode: 'dry-run' | 'live';
  blocked: boolean;
  blockedReason?: string;
  checks: Array<{
    name: string;
    passed: boolean;
    details: string;
  }>;
};

const PROVIDER_ARG = (process.argv.find((arg) => arg.startsWith('--provider=')) ?? '').split('=')[1]?.toUpperCase() as ProviderCode | undefined;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.PROVIDER_SANDBOX_E2E_DRY_RUN === 'true';

const redacted = (value: string | undefined | null) => {
  if (!value) return null;
  if (value.length <= 4) return '***REDACTED***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
};

const redactObject = (input: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, /secret|password|token|key|hash/i.test(key) ? redacted(value) : value])
  );

const boolEnv = (key: string) => (process.env[key] ?? '').toLowerCase() === 'true';

const ensureSafetyGuards = () => {
  if (!boolEnv('PROVIDER_SANDBOX_E2E_ENABLED')) {
    throw new Error('Blocked: set PROVIDER_SANDBOX_E2E_ENABLED=true to run provider sandbox E2E.');
  }

  if (!boolEnv('PROVIDER_SANDBOX_MODE')) {
    throw new Error('Blocked: set PROVIDER_SANDBOX_MODE=true to confirm sandbox-only execution.');
  }

  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new Error('Blocked: NODE_ENV=production is not allowed for sandbox E2E runs.');
  }
};

const baseInput = {
  sessionId: 'sandbox_e2e_session',
  merchantId: 'sandbox_e2e_merchant',
  orderId: `sandbox-${Date.now()}`,
  amountMinor: '100',
  amountDecimal: '1.00',
  amount: 100,
  currency: 'BDT',
  country: 'BD',
  purpose: 'DONATION',
  customer: {
    name: 'Sandbox Test User',
    email: 'sandbox@example.com',
    phone: '01700000000',
    country: 'Bangladesh'
  },
  successUrl: process.env.PROVIDER_SANDBOX_RETURN_URL ?? 'http://localhost:4000/api/v1/providers/sandbox/success',
  cancelUrl: process.env.PROVIDER_SANDBOX_RETURN_URL ?? 'http://localhost:4000/api/v1/providers/sandbox/cancel',
  callbackUrl: process.env.PROVIDER_SANDBOX_CALLBACK_URL ?? 'http://localhost:4000/api/v1/providers/sandbox/callback'
} as const;

const providers: ProviderEnvConfig[] = [
  {
    code: 'EPS',
    adapter: new EPSProviderAdapter(),
    requiredEnvKeys: [
      'SANDBOX_EPS_USERNAME',
      'SANDBOX_EPS_PASSWORD',
      'SANDBOX_EPS_HASH_KEY',
      'SANDBOX_EPS_MERCHANT_ID',
      'SANDBOX_EPS_STORE_ID',
      'SANDBOX_EPS_BASE_URL'
    ],
    buildCredentials: () => ({
      username: process.env.SANDBOX_EPS_USERNAME ?? '',
      password: process.env.SANDBOX_EPS_PASSWORD ?? '',
      hashKey: process.env.SANDBOX_EPS_HASH_KEY ?? '',
      merchantId: process.env.SANDBOX_EPS_MERCHANT_ID ?? '',
      storeId: process.env.SANDBOX_EPS_STORE_ID ?? '',
      baseUrl: process.env.SANDBOX_EPS_BASE_URL ?? '',
      sandbox: 'true',
      timeoutMs: process.env.SANDBOX_EPS_TIMEOUT_MS ?? '30000'
    })
  },
  {
    code: 'BKASH',
    adapter: new BKASHProviderAdapter(),
    requiredEnvKeys: [
      'SANDBOX_BKASH_APP_KEY',
      'SANDBOX_BKASH_APP_SECRET',
      'SANDBOX_BKASH_USERNAME',
      'SANDBOX_BKASH_PASSWORD',
      'SANDBOX_BKASH_BASE_URL'
    ],
    buildCredentials: () => ({
      appKey: process.env.SANDBOX_BKASH_APP_KEY ?? '',
      appSecret: process.env.SANDBOX_BKASH_APP_SECRET ?? '',
      username: process.env.SANDBOX_BKASH_USERNAME ?? '',
      password: process.env.SANDBOX_BKASH_PASSWORD ?? '',
      baseUrl: process.env.SANDBOX_BKASH_BASE_URL ?? '',
      sandbox: 'true',
      timeoutMs: process.env.SANDBOX_BKASH_TIMEOUT_MS ?? '30000'
    })
  },
  {
    code: 'NAGAD',
    adapter: new NAGADProviderAdapter(),
    requiredEnvKeys: [
      'SANDBOX_NAGAD_MERCHANT_ID',
      'SANDBOX_NAGAD_PUBLIC_KEY',
      'SANDBOX_NAGAD_PRIVATE_KEY',
      'SANDBOX_NAGAD_BASE_URL',
      'SANDBOX_NAGAD_CALLBACK_URL'
    ],
    buildCredentials: () => ({
      merchantId: process.env.SANDBOX_NAGAD_MERCHANT_ID ?? '',
      publicKey: process.env.SANDBOX_NAGAD_PUBLIC_KEY ?? '',
      privateKey: process.env.SANDBOX_NAGAD_PRIVATE_KEY ?? '',
      baseUrl: process.env.SANDBOX_NAGAD_BASE_URL ?? '',
      callbackUrl: process.env.SANDBOX_NAGAD_CALLBACK_URL ?? '',
      sandbox: 'true',
      timeoutMs: process.env.SANDBOX_NAGAD_TIMEOUT_MS ?? '30000'
    })
  },
  {
    code: 'SSLCOMMERZ',
    adapter: new SSLCOMMERZProviderAdapter(),
    requiredEnvKeys: [
      'SANDBOX_SSLCOMMERZ_STORE_ID',
      'SANDBOX_SSLCOMMERZ_STORE_PASSWORD',
      'SANDBOX_SSLCOMMERZ_BASE_URL',
      'SANDBOX_SSLCOMMERZ_IPN_URL'
    ],
    buildCredentials: () => ({
      storeId: process.env.SANDBOX_SSLCOMMERZ_STORE_ID ?? '',
      storePassword: process.env.SANDBOX_SSLCOMMERZ_STORE_PASSWORD ?? '',
      baseUrl: process.env.SANDBOX_SSLCOMMERZ_BASE_URL ?? '',
      ipnUrl: process.env.SANDBOX_SSLCOMMERZ_IPN_URL ?? '',
      sandbox: 'true',
      timeoutMs: process.env.SANDBOX_SSLCOMMERZ_TIMEOUT_MS ?? '30000'
    })
  }
];

const hasAllCredentials = (provider: ProviderEnvConfig) =>
  provider.requiredEnvKeys.every((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });

const runDryChecks = async (provider: ProviderEnvConfig): Promise<ProviderRunResult> => {
  const credentials = provider.buildCredentials();
  const credentialsReady = hasAllCredentials(provider);

  const checks: ProviderRunResult['checks'] = [
    {
      name: 'env-guards',
      passed: true,
      details: 'Sandbox E2E guard flags accepted.'
    },
    {
      name: 'credential-presence',
      passed: credentialsReady,
      details: credentialsReady
        ? `Required sandbox credentials present.`
        : `Missing required env keys: ${provider.requiredEnvKeys.filter((key) => !(process.env[key] ?? '').trim()).join(', ')}`
    },
    {
      name: 'credential-redaction',
      passed: true,
      details: JSON.stringify(redactObject(credentials))
    },
    {
      name: 'callback-shape',
      passed: true,
      details: `Expected callback base URL: ${baseInput.callbackUrl}`
    },
    {
      name: 'refund-fallback',
      passed: true,
      details: 'Refund is expected to remain unsupported/manual-review in sandbox v1.'
    }
  ];

  return {
    provider: provider.code,
    mode: 'dry-run',
    blocked: !credentialsReady,
    blockedReason: credentialsReady ? undefined : 'Missing sandbox credentials',
    checks
  };
};

const runLiveChecks = async (provider: ProviderEnvConfig): Promise<ProviderRunResult> => {
  const credentials = provider.buildCredentials();
  if (!hasAllCredentials(provider)) {
    return {
      provider: provider.code,
      mode: 'live',
      blocked: true,
      blockedReason: 'Missing sandbox credentials',
      checks: [
        {
          name: 'credential-presence',
          passed: false,
          details: `Missing required env keys: ${provider.requiredEnvKeys.filter((key) => !(process.env[key] ?? '').trim()).join(', ')}`
        }
      ]
    };
  }

  const checks: ProviderRunResult['checks'] = [];

  try {
    const created = await provider.adapter.createPayment({
      ...baseInput,
      credentials,
      callbackUrl: provider.code === 'NAGAD'
        ? (process.env.SANDBOX_NAGAD_CALLBACK_URL ?? baseInput.callbackUrl)
        : baseInput.callbackUrl
    });

    checks.push({
      name: 'create-payment',
      passed: true,
      details: JSON.stringify({
        providerSessionId: created.providerSessionId,
        providerReference: created.providerReference,
        rawResponseKeys: Object.keys(created.rawResponse)
      })
    });

    const leaked = JSON.stringify(created.rawResponse).match(/appSecret|password|token|privateKey|storePassword/i);
    checks.push({
      name: 'secret-redaction',
      passed: !leaked,
      details: leaked ? 'Sensitive token/credential key appeared in createPayment output.' : 'No obvious secret keys exposed in createPayment output.'
    });

    const verified = await provider.adapter.verifyPayment({
      providerReference: created.providerReference,
      providerSessionId: created.providerSessionId,
      credentials
    });

    checks.push({
      name: 'verify-payment',
      passed: ['PENDING', 'SUCCESS', 'FAILED'].includes(verified.status),
      details: `Provider returned verification status ${verified.status}.`
    });

    try {
      await provider.adapter.refundPayment({
        providerReference: created.providerReference,
        credentials
      });

      checks.push({
        name: 'refund-fallback',
        passed: false,
        details: 'Refund unexpectedly returned success path.'
      });
    } catch (error) {
      const passed = error instanceof ApiError && error.statusCode === 501;
      checks.push({
        name: 'refund-fallback',
        passed,
        details: passed ? 'Refund path correctly returned not-implemented/manual-review signal.' : `Refund path returned unexpected error: ${error instanceof Error ? error.message : 'unknown'}`
      });
    }

    checks.push({
      name: 'callback-shape',
      passed: true,
      details: 'Manual provider callback/webhook execution still requires provider-side redirect/IPN trigger.'
    });

    return {
      provider: provider.code,
      mode: 'live',
      blocked: false,
      checks
    };
  } catch (error) {
    checks.push({
      name: 'create-payment',
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown provider error'
    });

    return {
      provider: provider.code,
      mode: 'live',
      blocked: false,
      checks
    };
  }
};

const printResult = (result: ProviderRunResult) => {
  console.log(`\n[${result.provider}] mode=${result.mode} blocked=${result.blocked ? 'yes' : 'no'}`);
  if (result.blockedReason) {
    console.log(`blocked_reason=${result.blockedReason}`);
  }

  for (const check of result.checks) {
    console.log(`- ${check.name}: ${check.passed ? 'PASS' : 'FAIL'} :: ${check.details}`);
  }
};

const main = async () => {
  ensureSafetyGuards();

  const selectedProviders = PROVIDER_ARG
    ? providers.filter((provider) => provider.code === PROVIDER_ARG)
    : providers;

  if (selectedProviders.length === 0) {
    throw new Error(`Unknown provider selection: ${PROVIDER_ARG}`);
  }

  console.log(`Provider sandbox E2E runner started. mode=${DRY_RUN ? 'dry-run' : 'live'} providers=${selectedProviders.map((p) => p.code).join(',')}`);

  const results: ProviderRunResult[] = [];
  for (const provider of selectedProviders) {
    const result = DRY_RUN ? await runDryChecks(provider) : await runLiveChecks(provider);
    printResult(result);
    results.push(result);
  }

  const failed = results.some((result) => result.checks.some((check) => !check.passed && !result.blocked));
  if (failed) {
    process.exitCode = 1;
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
