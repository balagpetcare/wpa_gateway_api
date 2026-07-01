/**
 * Purpose-Based Payment Gateway Seed
 * Seeds credential profiles, routing rules, and fee rules for local dev / QA.
 * Idempotent — safe to run multiple times.
 */
import type { PrismaClient } from '@prisma/client';
import { encryptValue } from '../../src/utils/encrypt.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type ProfileSeed = {
  label: string;
  providerName: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  scope: 'PLATFORM' | 'MERCHANT';
  supportedPurposes: string[];
  countryCodes: string[];
  currencyCodes: string[];
  priority: number;
  secrets: Record<string, string>;
};

type RoutingRuleSeed = {
  countryCode: string;
  currencyCode: string;
  purpose: string;
  providerName: string;
  profileLabel: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  priority: number;
  fallbackAllowed: boolean;
};

type FeeRuleSeed = {
  providerName: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  purpose: string;
  countryCode: string | null;
  currencyCode: string | null;
  percentageFee: number;
  fixedFee: number;
  minFee: number | null;
  maxFee: number | null;
  feeBearer: 'CUSTOMER' | 'MERCHANT' | 'PLATFORM' | 'SHARED';
};

// ── Credential profile definitions ────────────────────────────────────────────

const PROFILE_SEEDS: ProfileSeed[] = [
  {
    label: 'EPS Sandbox - WPA Campaign',
    providerName: 'EPS',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['CAMPAIGN'],
    countryCodes: ['BD'],
    currencyCodes: ['BDT'],
    priority: 10,
    secrets: {
      username: 'sandbox-campaign@eps.local',
      password: 'eps-campaign-secret',
      hashKey: 'eps-campaign-hash-key-base64==',
      merchantId: 'eps-campaign-merchant-00000001',
      storeId: 'eps-campaign-store-11111111',
      baseUrl: 'https://sandbox-pgapi.eps.com.bd',
      sandbox: 'true',
    },
  },
  {
    label: 'EPS Sandbox - WPA Membership',
    providerName: 'EPS',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['MEMBERSHIP'],
    countryCodes: ['BD'],
    currencyCodes: ['BDT'],
    priority: 20,
    secrets: {
      username: 'sandbox-membership@eps.local',
      password: 'eps-membership-secret',
      hashKey: 'eps-membership-hash-key-base64==',
      merchantId: 'eps-membership-merchant-00000002',
      storeId: 'eps-membership-store-22222222',
      baseUrl: 'https://sandbox-pgapi.eps.com.bd',
      sandbox: 'true',
    },
  },
  {
    label: 'NAGAD Sandbox - WPA Donation',
    providerName: 'NAGAD',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['DONATION'],
    countryCodes: ['BD'],
    currencyCodes: ['BDT'],
    priority: 10,
    secrets: {
      merchantId: 'nagad-donation-mid-6800000001',
      publicKey: 'nagad-donation-public-key-sandbox',
      privateKey: 'nagad-donation-private-key-sandbox',
      baseUrl: 'https://sandbox.mynagad.com',
      callbackUrl: 'https://pay.worldpetsassociation.com/api/v1/providers/nagad/callback',
    },
  },
  {
    label: 'NAGAD Sandbox - WPA General Sales',
    providerName: 'NAGAD',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['GENERAL_SALE'],
    countryCodes: ['BD'],
    currencyCodes: ['BDT'],
    priority: 20,
    secrets: {
      merchantId: 'nagad-general-mid-6800000002',
      publicKey: 'nagad-general-public-key-sandbox',
      privateKey: 'nagad-general-private-key-sandbox',
      baseUrl: 'https://sandbox.mynagad.com',
      callbackUrl: 'https://pay.worldpetsassociation.com/api/v1/providers/nagad/callback',
    },
  },
  {
    label: 'BKASH Sandbox - WPA Donation',
    providerName: 'BKASH',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['DONATION', 'MEMBERSHIP'],
    countryCodes: ['BD'],
    currencyCodes: ['BDT'],
    priority: 10,
    secrets: {
      appKey: 'bkash-sandbox-app-key-donation',
      appSecret: 'bkash-sandbox-app-secret-donation',
      username: 'sandbox-donation@bkash.local',
      password: 'bkash-donation-secret',
      baseUrl: 'https://tokenized.sandbox.bka.sh',
    },
  },
  {
    label: 'SSLCOMMERZ Sandbox - WPA Marketplace',
    providerName: 'SSLCOMMERZ',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['MARKETPLACE', 'GENERAL_SALE'],
    countryCodes: ['BD'],
    currencyCodes: ['BDT'],
    priority: 10,
    secrets: {
      storeId: 'wpa_marketplace_store',
      storePassword: 'ssl-marketplace-store-password',
      baseUrl: 'https://sandbox.sslcommerz.com',
      ipnUrl: 'https://pay.worldpetsassociation.com/api/v1/providers/sslcommerz/ipn',
    },
  },
  {
    label: 'STRIPE Sandbox - Global Fallback',
    providerName: 'STRIPE',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'GENERAL_SALE', 'ALL_PURPOSES'],
    countryCodes: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'JP', 'SG'],
    currencyCodes: ['USD', 'GBP', 'CAD', 'AUD', 'EUR', 'JPY', 'SGD'],
    priority: 100,
    secrets: {
      publishableKey: 'pk_test_sandbox_stripe_wpa_global_fallback',
      secretKey: 'sk_test_sandbox_stripe_wpa_global_fallback',
      webhookSecret: 'whsec_sandbox_stripe_wpa_global_fallback',
    },
  },
  {
    label: 'PAYPAL Sandbox - Global Fallback',
    providerName: 'PAYPAL',
    environment: 'SANDBOX',
    scope: 'PLATFORM',
    supportedPurposes: ['DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'GENERAL_SALE', 'ALL_PURPOSES'],
    countryCodes: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'JP', 'SG'],
    currencyCodes: ['USD', 'GBP', 'CAD', 'AUD', 'EUR', 'JPY', 'SGD'],
    priority: 200,
    secrets: {
      clientId: 'paypal-sandbox-client-id-wpa-global-fallback',
      clientSecret: 'paypal-sandbox-client-secret-wpa-global-fallback',
      webhookId: 'paypal-sandbox-webhook-id-wpa',
      baseUrl: 'https://api-m.sandbox.paypal.com',
    },
  },
];

// ── Routing rule definitions ───────────────────────────────────────────────────

const ROUTING_RULE_SEEDS: RoutingRuleSeed[] = [
  // Bangladesh BDT — DONATION
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'DONATION', providerName: 'NAGAD',     profileLabel: 'NAGAD Sandbox - WPA Donation',       environment: 'SANDBOX', priority: 1,  fallbackAllowed: true },
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'DONATION', providerName: 'BKASH',     profileLabel: 'BKASH Sandbox - WPA Donation',        environment: 'SANDBOX', priority: 2,  fallbackAllowed: true },
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'DONATION', providerName: 'EPS',       profileLabel: 'EPS Sandbox - WPA Campaign',          environment: 'SANDBOX', priority: 3,  fallbackAllowed: true },
  // Bangladesh BDT — MEMBERSHIP
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'MEMBERSHIP', providerName: 'EPS',     profileLabel: 'EPS Sandbox - WPA Membership',        environment: 'SANDBOX', priority: 1,  fallbackAllowed: true },
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'MEMBERSHIP', providerName: 'BKASH',   profileLabel: 'BKASH Sandbox - WPA Donation',        environment: 'SANDBOX', priority: 2,  fallbackAllowed: true },
  // Bangladesh BDT — CAMPAIGN
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'CAMPAIGN',   providerName: 'EPS',     profileLabel: 'EPS Sandbox - WPA Campaign',          environment: 'SANDBOX', priority: 1,  fallbackAllowed: true },
  // Bangladesh BDT — GENERAL_SALE
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'GENERAL_SALE', providerName: 'NAGAD', profileLabel: 'NAGAD Sandbox - WPA General Sales',  environment: 'SANDBOX', priority: 1,  fallbackAllowed: true },
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'GENERAL_SALE', providerName: 'SSLCOMMERZ', profileLabel: 'SSLCOMMERZ Sandbox - WPA Marketplace', environment: 'SANDBOX', priority: 2, fallbackAllowed: true },
  // Bangladesh BDT — MARKETPLACE
  { countryCode: 'BD', currencyCode: 'BDT', purpose: 'MARKETPLACE', providerName: 'SSLCOMMERZ', profileLabel: 'SSLCOMMERZ Sandbox - WPA Marketplace', environment: 'SANDBOX', priority: 1, fallbackAllowed: true },
  // US USD — ALL_PURPOSES (global stripe / paypal)
  { countryCode: 'US', currencyCode: 'USD', purpose: 'ALL_PURPOSES', providerName: 'STRIPE', profileLabel: 'STRIPE Sandbox - Global Fallback',  environment: 'SANDBOX', priority: 1,  fallbackAllowed: true },
  { countryCode: 'US', currencyCode: 'USD', purpose: 'ALL_PURPOSES', providerName: 'PAYPAL', profileLabel: 'PAYPAL Sandbox - Global Fallback',   environment: 'SANDBOX', priority: 2,  fallbackAllowed: true },
];

// ── Fee rule definitions ───────────────────────────────────────────────────────
// Different percentages per purpose so fee calculation results are clearly distinct.

const FEE_RULE_SEEDS: FeeRuleSeed[] = [
  // BD/BDT purpose-based rules (applied to all BD providers via null credentialProfileId + BD country)
  { providerName: 'NAGAD',      environment: 'SANDBOX', purpose: 'DONATION',    countryCode: 'BD', currencyCode: 'BDT', percentageFee: 1.5,  fixedFee: 0,   minFee: null, maxFee: 500,   feeBearer: 'CUSTOMER' },
  { providerName: 'BKASH',      environment: 'SANDBOX', purpose: 'DONATION',    countryCode: 'BD', currencyCode: 'BDT', percentageFee: 1.5,  fixedFee: 0,   minFee: null, maxFee: 500,   feeBearer: 'CUSTOMER' },
  { providerName: 'EPS',        environment: 'SANDBOX', purpose: 'DONATION',    countryCode: 'BD', currencyCode: 'BDT', percentageFee: 1.5,  fixedFee: 0,   minFee: null, maxFee: 500,   feeBearer: 'CUSTOMER' },
  { providerName: 'EPS',        environment: 'SANDBOX', purpose: 'MEMBERSHIP',  countryCode: 'BD', currencyCode: 'BDT', percentageFee: 2.0,  fixedFee: 10,  minFee: 15,   maxFee: 2000,  feeBearer: 'MERCHANT' },
  { providerName: 'BKASH',      environment: 'SANDBOX', purpose: 'MEMBERSHIP',  countryCode: 'BD', currencyCode: 'BDT', percentageFee: 2.0,  fixedFee: 10,  minFee: 15,   maxFee: 2000,  feeBearer: 'MERCHANT' },
  { providerName: 'EPS',        environment: 'SANDBOX', purpose: 'CAMPAIGN',    countryCode: 'BD', currencyCode: 'BDT', percentageFee: 1.0,  fixedFee: 0,   minFee: null, maxFee: null,  feeBearer: 'PLATFORM' },
  { providerName: 'NAGAD',      environment: 'SANDBOX', purpose: 'GENERAL_SALE',countryCode: 'BD', currencyCode: 'BDT', percentageFee: 2.5,  fixedFee: 5,   minFee: 10,   maxFee: 5000,  feeBearer: 'MERCHANT' },
  { providerName: 'SSLCOMMERZ', environment: 'SANDBOX', purpose: 'GENERAL_SALE',countryCode: 'BD', currencyCode: 'BDT', percentageFee: 2.5,  fixedFee: 5,   minFee: 10,   maxFee: 5000,  feeBearer: 'MERCHANT' },
  { providerName: 'SSLCOMMERZ', environment: 'SANDBOX', purpose: 'MARKETPLACE', countryCode: 'BD', currencyCode: 'BDT', percentageFee: 3.0,  fixedFee: 0,   minFee: null, maxFee: null,  feeBearer: 'SHARED'   },
  // Global USD rules
  { providerName: 'STRIPE',     environment: 'SANDBOX', purpose: 'ALL_PURPOSES',countryCode: 'US', currencyCode: 'USD', percentageFee: 2.9,  fixedFee: 30,  minFee: null, maxFee: null,  feeBearer: 'MERCHANT' },
  { providerName: 'PAYPAL',     environment: 'SANDBOX', purpose: 'ALL_PURPOSES',countryCode: 'US', currencyCode: 'USD', percentageFee: 3.49, fixedFee: 49,  minFee: null, maxFee: null,  feeBearer: 'MERCHANT' },
  // SUBSCRIPTION: fallback global STRIPE rule (no country filter → applies to any country)
  { providerName: 'STRIPE',     environment: 'SANDBOX', purpose: 'SUBSCRIPTION',countryCode: null, currencyCode: null,  percentageFee: 1.8,  fixedFee: 0,   minFee: null, maxFee: null,  feeBearer: 'CUSTOMER' },
];

// ── Main seeder function ───────────────────────────────────────────────────────

export async function seedPurposeBasedGateway(
  prisma: PrismaClient,
  encryptionKey: string
): Promise<{
  providersActivated: string[];
  profilesCreated: number;
  profilesSkipped: number;
  routingRulesCreated: number;
  routingRulesSkipped: number;
  feeRulesCreated: number;
  feeRulesSkipped: number;
}> {
  const result = {
    providersActivated: [] as string[],
    profilesCreated: 0,
    profilesSkipped: 0,
    routingRulesCreated: 0,
    routingRulesSkipped: 0,
    feeRulesCreated: 0,
    feeRulesSkipped: 0,
  };

  // ── 1. Ensure PAYPAL SANDBOX provider exists ────────────────────────────────
  await prisma.paymentProvider.upsert({
    where: { name_environment: { name: 'PAYPAL', environment: 'SANDBOX' } },
    update: {
      displayName: 'PayPal Sandbox',
      checkoutDisplayName: 'PayPal',
      checkoutDescription: 'Pay with your PayPal account',
      brandColor: '#003087',
      isActive: true,
      isDevelopmentOnly: false,
      adapterType: 'redirect',
      coverageType: 'GLOBAL',
      regionCode: null,
      supportedCurrencies: ['USD', 'GBP', 'CAD', 'AUD', 'EUR', 'JPY', 'SGD'],
      supportedCountries: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'JP', 'SG'],
      supportedRegions: [],
      excludedCountries: [],
      allowCurrencyConversion: true,
      priority: 10,
    },
    create: {
      name: 'PAYPAL',
      displayName: 'PayPal Sandbox',
      checkoutDisplayName: 'PayPal',
      checkoutDescription: 'Pay with your PayPal account',
      brandColor: '#003087',
      isActive: true,
      isDevelopmentOnly: false,
      environment: 'SANDBOX',
      adapterType: 'redirect',
      coverageType: 'GLOBAL',
      regionCode: null,
      supportedCurrencies: ['USD', 'GBP', 'CAD', 'AUD', 'EUR', 'JPY', 'SGD'],
      supportedCountries: ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'JP', 'SG'],
      supportedRegions: [],
      excludedCountries: [],
      allowCurrencyConversion: true,
      priority: 10,
    },
  });

  // ── 2. Activate BD providers and set STRIPE SANDBOX to GLOBAL ──────────────
  const toActivate = [
    { name: 'EPS',        environment: 'SANDBOX' as const, coverageType: 'LOCAL'  as const },
    { name: 'BKASH',      environment: 'SANDBOX' as const, coverageType: 'LOCAL'  as const },
    { name: 'NAGAD',      environment: 'SANDBOX' as const, coverageType: 'LOCAL'  as const },
    { name: 'SSLCOMMERZ', environment: 'SANDBOX' as const, coverageType: 'LOCAL'  as const },
    { name: 'STRIPE',     environment: 'SANDBOX' as const, coverageType: 'GLOBAL' as const },
    { name: 'PAYPAL',     environment: 'SANDBOX' as const, coverageType: 'GLOBAL' as const },
  ];

  for (const p of toActivate) {
    const updated = await prisma.paymentProvider.updateMany({
      where: { name: p.name as any, environment: p.environment },
      data: { isActive: true, coverageType: p.coverageType },
    });
    if (updated.count > 0) result.providersActivated.push(`${p.name}:${p.environment}`);
  }

  // ── 3. Fetch provider map for lookups ──────────────────────────────────────
  const allProviders = await prisma.paymentProvider.findMany({
    where: { environment: 'SANDBOX' },
    select: { id: true, name: true },
  });
  const providerByName = new Map(allProviders.map((p) => [p.name, p.id]));

  // ── 4. Seed credential profiles ────────────────────────────────────────────
  const profileIdByLabel = new Map<string, string>();

  for (const ps of PROFILE_SEEDS) {
    const providerId = providerByName.get(ps.providerName as any);
    if (!providerId) {
      console.warn(`  ⚠ Provider ${ps.providerName} not found — skipping profile "${ps.label}"`);
      result.profilesSkipped++;
      continue;
    }

    const existing = await prisma.credentialProfile.findFirst({
      where: { providerId, environment: ps.environment, scope: ps.scope, merchantId: null, label: ps.label },
      select: { id: true },
    });

    if (existing) {
      profileIdByLabel.set(ps.label, existing.id);
      result.profilesSkipped++;
      continue;
    }

    const secretsJson = JSON.stringify(ps.secrets);
    const encrypted = encryptValue(secretsJson, encryptionKey);

    const profile = await prisma.credentialProfile.create({
      data: {
        providerId,
        environment: ps.environment,
        scope: ps.scope,
        merchantId: null,
        label: ps.label,
        supportedPurposes: ps.supportedPurposes as any[],
        countryCodes: ps.countryCodes,
        currencyCodes: ps.currencyCodes,
        priority: ps.priority,
        isActive: true,
        encryptedSecrets: { iv: encrypted.iv, authTag: encrypted.authTag, ciphertext: encrypted.ciphertext },
        createdById: null,
      },
      select: { id: true },
    });

    profileIdByLabel.set(ps.label, profile.id);
    result.profilesCreated++;
  }

  // ── 5. Seed routing rules ──────────────────────────────────────────────────
  for (const rr of ROUTING_RULE_SEEDS) {
    const providerId = providerByName.get(rr.providerName as any);
    if (!providerId) {
      console.warn(`  ⚠ Provider ${rr.providerName} not found — skipping routing rule`);
      result.routingRulesSkipped++;
      continue;
    }

    const profileId = rr.profileLabel ? (profileIdByLabel.get(rr.profileLabel) ?? null) : null;

    const existing = await prisma.gatewayRoutingRule.findFirst({
      where: {
        countryCode: rr.countryCode,
        currencyCode: rr.currencyCode,
        purpose: rr.purpose as any,
        providerId,
        environment: rr.environment,
        scopeType: 'PLATFORM',
        scopeId: null,
      },
      select: { id: true },
    });

    if (existing) {
      result.routingRulesSkipped++;
      continue;
    }

    await prisma.gatewayRoutingRule.create({
      data: {
        providerId,
        credentialProfileId: profileId,
        countryCode: rr.countryCode,
        currencyCode: rr.currencyCode,
        purpose: rr.purpose as any,
        environment: rr.environment,
        scopeType: 'PLATFORM',
        scopeId: null,
        priority: rr.priority,
        showAtCheckout: true,
        fallbackAllowed: rr.fallbackAllowed,
        isActive: true,
      },
    });

    result.routingRulesCreated++;
  }

  // ── 6. Seed fee rules ──────────────────────────────────────────────────────
  for (const fr of FEE_RULE_SEEDS) {
    const providerId = providerByName.get(fr.providerName as any);
    if (!providerId) {
      console.warn(`  ⚠ Provider ${fr.providerName} not found — skipping fee rule`);
      result.feeRulesSkipped++;
      continue;
    }

    const existing = await prisma.gatewayFeeRule.findFirst({
      where: {
        providerId,
        environment: fr.environment,
        purpose: fr.purpose as any,
        countryCode: fr.countryCode,
        currencyCode: fr.currencyCode,
        credentialProfileId: null,
      },
      select: { id: true },
    });

    if (existing) {
      result.feeRulesSkipped++;
      continue;
    }

    await prisma.gatewayFeeRule.create({
      data: {
        providerId,
        credentialProfileId: null,
        countryCode: fr.countryCode,
        currencyCode: fr.currencyCode,
        purpose: fr.purpose as any,
        environment: fr.environment,
        percentageFee: fr.percentageFee,
        fixedFee: fr.fixedFee,
        minFee: fr.minFee,
        maxFee: fr.maxFee,
        feeBearer: fr.feeBearer,
        isActive: true,
      },
    });

    result.feeRulesCreated++;
  }

  return result;
}
