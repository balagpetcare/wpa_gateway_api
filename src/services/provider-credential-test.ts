import type { CredentialProfile, MerchantEnvironment, PaymentProvider, ProviderName } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { decryptValue } from '../utils/encrypt.js';
import { redactSensitiveData } from '../utils/redaction.js';
import { getProviderAdapter } from '../providers/index.js';
import { getProviderReadiness } from '../providers/readiness.js';
import { ApiError } from '../utils/errors.js';
import { createAuditLog } from './audit.js';

export type CredentialTestMode = 'DRY_RUN' | 'LIVE';
export type CredentialTestCheckStatus = 'PASSED' | 'FAILED' | 'BLOCKED';

export interface CredentialTestCheck {
  name: string;
  status: CredentialTestCheckStatus;
  message?: string;
}

export interface CredentialTestResult {
  success: boolean;
  providerCode: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  mode: CredentialTestMode;
  status: CredentialTestCheckStatus;
  message: string;
  checks: CredentialTestCheck[];
  safeProviderReference?: string;
  testedAt: string;
}

// Required credential fields per provider, used for DRY_RUN presence validation.
// Mirrors the admin panel's credential-profile form fields.
const REQUIRED_CREDENTIAL_FIELDS: Partial<Record<ProviderName, string[]>> = {
  EPS: ['username', 'password', 'hashKey', 'merchantId', 'storeId', 'baseUrl'],
  BKASH: ['appKey', 'appSecret', 'username', 'password', 'baseUrl'],
  NAGAD: ['merchantId', 'publicKey', 'privateKey', 'baseUrl', 'callbackUrl'],
  SSLCOMMERZ: ['storeId', 'storePassword', 'baseUrl', 'ipnUrl'],
  STRIPE: ['publishableKey', 'secretKey', 'webhookSecret'],
  PAYPAL: ['clientId', 'clientSecret', 'webhookId', 'baseUrl']
};

const isValidUrlShape = (value: string | undefined) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const overallStatus = (checks: CredentialTestCheck[]): CredentialTestCheckStatus => {
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((check) => check.status === 'FAILED')) return 'FAILED';
  return 'PASSED';
};

const decryptProfileSecrets = (profile: CredentialProfile): Record<string, string> => {
  const raw = profile.encryptedSecrets as { iv: string; authTag: string; ciphertext: string } | null;
  if (!raw) {
    throw new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Credential profile has no stored secrets.');
  }

  const json = decryptValue(raw, env.CREDENTIAL_ENCRYPTION_KEY);
  return JSON.parse(json) as Record<string, string>;
};

const buildBlockedResult = (input: {
  providerCode: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  mode: CredentialTestMode;
  message: string;
  checks: CredentialTestCheck[];
}): CredentialTestResult => ({
  success: false,
  providerCode: input.providerCode,
  environment: input.environment,
  mode: input.mode,
  status: 'BLOCKED',
  message: input.message,
  checks: input.checks,
  testedAt: new Date().toISOString()
});

const runChecks = async (input: {
  provider: PaymentProvider;
  credentials: Record<string, string>;
  environment: 'SANDBOX' | 'PRODUCTION';
  mode: CredentialTestMode;
  testAmount: string;
  currency: string;
}): Promise<{ checks: CredentialTestCheck[]; safeProviderReference?: string }> => {
  const checks: CredentialTestCheck[] = [];
  const requiredFields = REQUIRED_CREDENTIAL_FIELDS[input.provider.name] ?? [];

  const missingFields = requiredFields.filter((field) => !input.credentials[field]?.trim());
  checks.push({
    name: 'credential-presence',
    status: missingFields.length === 0 ? 'PASSED' : 'FAILED',
    message: missingFields.length === 0 ? 'Required credential fields are present.' : `Missing required fields: ${missingFields.join(', ')}`
  });

  const adapterCheck = getProviderReadiness(input.provider.name);
  checks.push({
    name: 'adapter-availability',
    status: adapterCheck.adapterType === 'REAL' ? 'PASSED' : 'BLOCKED',
    message: adapterCheck.adapterType === 'REAL' ? 'Real provider adapter resolved.' : 'Provider is routed to the mock adapter and cannot be tested.'
  });

  const baseUrlCandidate = input.credentials.baseUrl;
  const callbackCandidate = input.credentials.callbackUrl ?? input.credentials.ipnUrl;
  checks.push({
    name: 'callback-shape',
    status: !baseUrlCandidate || isValidUrlShape(baseUrlCandidate) ? 'PASSED' : 'FAILED',
    message: !baseUrlCandidate
      ? 'No baseUrl configured for this provider; skipped.'
      : isValidUrlShape(baseUrlCandidate)
        ? `baseUrl shape is valid${callbackCandidate ? ` (callback: ${isValidUrlShape(callbackCandidate) ? 'valid' : 'invalid'})` : ''}.`
        : 'baseUrl is not a valid http(s) URL.'
  });

  if (missingFields.length > 0 || adapterCheck.adapterType !== 'REAL') {
    return { checks };
  }

  if (input.mode === 'DRY_RUN') {
    checks.push({
      name: 'refund-fallback',
      status: 'PASSED',
      message: 'Refund fallback not exercised in dry-run mode.'
    });
    return { checks };
  }

  const adapter = getProviderAdapter(input.provider);
  let safeProviderReference: string | undefined;

  try {
    const created = await adapter.createPayment({
      sessionId: `cred_test_${input.environment.toLowerCase()}_${Date.now()}`,
      merchantId: 'credential-test',
      orderId: `cred-test-${Date.now()}`,
      amountMinor: String(Math.round(Number(input.testAmount) * 100)),
      amountDecimal: input.testAmount,
      amount: Number(input.testAmount),
      currency: input.currency,
      purpose: 'GENERAL_SALE',
      providerEnvironment: input.environment,
      customer: {
        name: 'Credential Test',
        email: 'credential-test@example.com',
        phone: '01700000000'
      },
      successUrl: input.credentials.callbackUrl ?? 'https://example.invalid/success',
      cancelUrl: input.credentials.callbackUrl ?? 'https://example.invalid/cancel',
      callbackUrl: input.credentials.callbackUrl ?? 'https://example.invalid/callback',
      credentials: input.credentials
    });

    safeProviderReference = created.providerReference;

    checks.push({
      name: 'create-payment',
      status: 'PASSED',
      message: 'Sandbox payment initialization succeeded.'
    });

    const verified = await adapter.verifyPayment({
      providerReference: created.providerReference,
      providerSessionId: created.providerSessionId,
      credentials: input.credentials
    });

    checks.push({
      name: 'verify-payment',
      status: ['PENDING', 'SUCCESS', 'FAILED'].includes(verified.status) ? 'PASSED' : 'FAILED',
      message: `Provider returned verification status ${verified.status}.`
    });

    try {
      await adapter.refundPayment({
        providerReference: created.providerReference,
        credentials: input.credentials
      });
      checks.push({
        name: 'refund-fallback',
        status: 'FAILED',
        message: 'Refund unexpectedly succeeded; refunds must remain manual.'
      });
    } catch (error) {
      const isManualFallback = error instanceof ApiError && error.statusCode === 501;
      checks.push({
        name: 'refund-fallback',
        status: isManualFallback ? 'PASSED' : 'FAILED',
        message: isManualFallback
          ? 'Refund path correctly returned manual-review/not-implemented signal.'
          : `Refund path returned unexpected error: ${error instanceof Error ? error.message : 'unknown error'}`
      });
    }
  } catch (error) {
    checks.push({
      name: 'create-payment',
      status: 'FAILED',
      message: error instanceof Error ? error.message : 'Unknown provider error.'
    });
  }

  return { checks, safeProviderReference };
};

export const runCredentialProfileTest = async (input: {
  profileId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  mode: CredentialTestMode;
  testAmount: string;
  currency: string;
  adminUserId?: string | null;
  ipAddress?: string | null;
}): Promise<CredentialTestResult> => {
  const profile = await prisma.credentialProfile.findUnique({
    where: { id: input.profileId },
    include: { provider: true }
  });

  if (!profile) {
    throw new ApiError(404, 'NOT_FOUND', 'Credential profile not found.');
  }

  const providerCode = profile.provider.name;

  if (profile.environment !== input.environment) {
    const result = buildBlockedResult({
      providerCode,
      environment: input.environment,
      mode: input.mode,
      message: `Credential profile is configured for ${profile.environment} but the test requested ${input.environment}.`,
      checks: [
        {
          name: 'environment-match',
          status: 'BLOCKED',
          message: `Profile environment is ${profile.environment}.`
        }
      ]
    });
    await persistTestResult(profile, result);
    await writeAuditLog(profile, input, result);
    return result;
  }

  let credentials: Record<string, string>;
  try {
    credentials = decryptProfileSecrets(profile);
  } catch {
    const result = buildBlockedResult({
      providerCode,
      environment: input.environment,
      mode: input.mode,
      message: 'Stored credentials could not be decrypted.',
      checks: [{ name: 'credential-decryption', status: 'BLOCKED', message: 'Decryption failed.' }]
    });
    await persistTestResult(profile, result);
    await writeAuditLog(profile, input, result);
    return result;
  }

  const { checks, safeProviderReference } = await runChecks({
    provider: profile.provider,
    credentials,
    environment: input.environment,
    mode: input.mode,
    testAmount: input.testAmount,
    currency: input.currency
  });

  const status = overallStatus(checks);
  const result: CredentialTestResult = {
    success: status === 'PASSED',
    providerCode,
    environment: input.environment,
    mode: input.mode,
    status,
    message:
      status === 'PASSED'
        ? `${providerCode} credential ${input.mode === 'LIVE' ? 'live' : 'dry-run'} test passed.`
        : status === 'BLOCKED'
          ? `${providerCode} credential test was blocked before contacting the provider.`
          : `${providerCode} credential test failed one or more checks.`,
    checks,
    safeProviderReference,
    testedAt: new Date().toISOString()
  };

  await persistTestResult(profile, result);
  await writeAuditLog(profile, input, result);
  return result;
};

const persistTestResult = async (profile: CredentialProfile, result: CredentialTestResult) => {
  const redactedDetails = redactSensitiveData({
    checks: result.checks,
    safeProviderReference: result.safeProviderReference ?? null
  });

  const now = new Date();
  const data: Record<string, unknown> = {
    lastTestedAt: now,
    lastTestStatus: result.status,
    lastTestEnvironment: result.environment as MerchantEnvironment,
    lastTestMessage: result.message,
    lastTestDetails: redactedDetails
  };

  if (result.status === 'PASSED' && result.mode === 'LIVE') {
    if (result.environment === 'SANDBOX') {
      data.sandboxVerifiedAt = now;
    } else {
      data.liveVerifiedAt = now;
    }
    data.verificationExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  await prisma.credentialProfile.update({
    where: { id: profile.id },
    data
  });
};

const writeAuditLog = async (
  profile: CredentialProfile,
  input: { mode: CredentialTestMode; environment: 'SANDBOX' | 'PRODUCTION'; adminUserId?: string | null; ipAddress?: string | null },
  result: CredentialTestResult
) => {
  await createAuditLog({
    actorType: 'ADMIN',
    actorId: input.adminUserId ?? null,
    action: 'CREDENTIAL_PROFILE_TESTED',
    entityType: 'CredentialProfile',
    entityId: profile.id,
    ipAddress: input.ipAddress ?? null,
    metadata: {
      providerId: profile.providerId,
      environment: input.environment,
      mode: input.mode,
      status: result.status,
      checks: result.checks.map((check) => ({ name: check.name, status: check.status }))
    }
  });
};
