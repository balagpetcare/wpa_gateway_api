import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient, AdminRole, CredentialScope, MerchantEnvironment, MerchantStatus, ProviderName, CoverageType, InternationalDisplayPolicy, RateSource } from '@prisma/client';
import { env } from '../src/config/env.js';
import { generateMerchantCredential, normalizeOrigin } from '../src/modules/merchants/shared.js';
import { encryptValue } from '../src/utils/encrypt.js';
import { COUNTRY_GATEWAY_RULES_SEED } from './seed-data/countryGatewayRules.js';
import { seedPurposeBasedGateway } from './seed-data/purposeBasedGatewaySeed.js';

type ProviderSeed = {
  name: ProviderName;
  displayName: string;
  checkoutDisplayName: string;
  checkoutDescription: string;
  brandColor: string | null;
  isActive: boolean;
  isDevelopmentOnly: boolean;
  environment: MerchantEnvironment;
  supportedCurrencies: string[];
  supportedCountries: string[];
  supportedRegions: string[];
  excludedCountries: string[];
  allowCurrencyConversion: boolean;
  priority: number;
  adapterType: string;
  coverageType: CoverageType;
  regionCode: string | null;
};

const prisma = new PrismaClient({
  log: ['warn', 'error']
});

const seedConfig = {
  adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@worldpetsassociation.com',
  adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'WpaAdmin123!',
  merchantName: 'furtail.app',
  merchantBusinessName: 'Furtail App LLC',
  merchantEmail: 'payments@furtail.app',
  merchantPhone: '+1 555 010 2400',
  merchantCallbackUrl: 'https://pay.worldpetsassociation.com/api/v1/callback',
  merchantApiKeyLabel: 'local-dev-primary',
  providerName: ProviderName.STRIPE,
  providerDisplayName: 'Mock Stripe',
  providerCredentialLabel: 'webhook_secret',
  providerCredentialValue: process.env.SEED_MOCK_PROVIDER_WEBHOOK_SECRET ?? 'mock_provider_webhook_secret_local_dev',
  epsProviderName: ProviderName.EPS,
  epsProviderDisplayName: 'EPS Sandbox',
  epsProviderActive: false,
  epsProviderCurrencies: ['BDT'],
  epsProviderCountries: ['BD'],
  epsProviderCredentialValues: {
    username: process.env.SEED_EPS_USERNAME ?? 'sandbox-user@eps.local',
    password: process.env.SEED_EPS_PASSWORD ?? 'change-me',
    hashKey: process.env.SEED_EPS_HASH_KEY ?? 'change-me-base64-hash-key',
    merchantId: process.env.SEED_EPS_MERCHANT_ID ?? '00000000-0000-0000-0000-000000000000',
    storeId: process.env.SEED_EPS_STORE_ID ?? '11111111-1111-1111-1111-111111111111',
    baseUrl: process.env.SEED_EPS_BASE_URL ?? 'https://sandbox-pgapi.eps.com.bd',
    sandbox: 'true'
  },
  domains: [
    'furtail.app',
    'api.furtail.app',
    'worldpetsassociation.com',
    'pay.worldpetsassociation.com',
    'localhost',
    '127.0.0.1'
  ]
} as const;

const additionalProviders: ProviderSeed[] = [
  // Bangladesh
  { name: ProviderName.BKASH,     displayName: 'bKash Sandbox',     checkoutDisplayName: 'bKash',     checkoutDescription: 'Pay with bKash mobile wallet',             brandColor: '#E2136E', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.SANDBOX,    supportedCurrencies: ['BDT'], supportedCountries: ['BD'], supportedRegions: ['SA'], excludedCountries: [], allowCurrencyConversion: false, priority: 1,  adapterType: 'redirect', coverageType: CoverageType.LOCAL,     regionCode: 'SA'  },
  { name: ProviderName.NAGAD,     displayName: 'Nagad Sandbox',     checkoutDisplayName: 'Nagad',     checkoutDescription: 'Pay with Nagad mobile wallet',             brandColor: '#F05829', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.SANDBOX,    supportedCurrencies: ['BDT'], supportedCountries: ['BD'], supportedRegions: ['SA'], excludedCountries: [], allowCurrencyConversion: false, priority: 2,  adapterType: 'redirect', coverageType: CoverageType.LOCAL,     regionCode: 'SA'  },
  { name: ProviderName.SSLCOMMERZ, displayName: 'SSLCommerz Sandbox', checkoutDisplayName: 'SSLCommerz', checkoutDescription: 'Pay via card or mobile banking',       brandColor: '#003F6B', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.SANDBOX,    supportedCurrencies: ['BDT'], supportedCountries: ['BD'], supportedRegions: ['SA'], excludedCountries: [], allowCurrencyConversion: false, priority: 3,  adapterType: 'redirect', coverageType: CoverageType.LOCAL,     regionCode: 'SA'  },
  // India
  { name: ProviderName.RAZORPAY,  displayName: 'India Razorpay',    checkoutDisplayName: 'Razorpay',  checkoutDescription: 'Pay with Razorpay',                       brandColor: '#072654', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.SANDBOX,    supportedCurrencies: ['INR'], supportedCountries: ['IN'], supportedRegions: ['SA'], excludedCountries: [], allowCurrencyConversion: false, priority: 1,  adapterType: 'api',      coverageType: CoverageType.REGIONAL,  regionCode: 'SA'  },
  { name: ProviderName.CASHFREE,  displayName: 'India Cashfree',    checkoutDisplayName: 'Cashfree',  checkoutDescription: 'Pay with Cashfree',                       brandColor: '#2D3A8C', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.SANDBOX,    supportedCurrencies: ['INR'], supportedCountries: ['IN'], supportedRegions: ['SA'], excludedCountries: [], allowCurrencyConversion: false, priority: 2,  adapterType: 'api',      coverageType: CoverageType.LOCAL,     regionCode: 'SA'  },
  // USA / Global
  { name: ProviderName.STRIPE,    displayName: 'USA Stripe',        checkoutDisplayName: 'Stripe',    checkoutDescription: 'Pay with credit or debit card via Stripe', brandColor: '#635BFF', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.PRODUCTION, supportedCurrencies: ['USD'], supportedCountries: ['US'], supportedRegions: [],    excludedCountries: [], allowCurrencyConversion: true,  priority: 1,  adapterType: 'api',      coverageType: CoverageType.GLOBAL,    regionCode: null  },
  { name: ProviderName.PAYPAL,    displayName: 'PayPal Global',     checkoutDisplayName: 'PayPal',    checkoutDescription: 'Pay with your PayPal account',            brandColor: '#003087', isActive: false, isDevelopmentOnly: false, environment: MerchantEnvironment.PRODUCTION, supportedCurrencies: ['USD'], supportedCountries: ['US'], supportedRegions: [],    excludedCountries: [], allowCurrencyConversion: true,  priority: 10, adapterType: 'redirect', coverageType: CoverageType.GLOBAL,    regionCode: null  },
];

const upsertMerchantDomains = async (merchantId: string) => {
  const desired = [...new Set(seedConfig.domains.map((domain) => domain.toLowerCase()))];

  await prisma.merchantDomain.deleteMany({
    where: {
      merchantId,
      normalizedOrigin: {
        notIn: desired
      }
    }
  });

  for (const domain of desired) {
    const normalized = normalizeOrigin(domain);
    await prisma.merchantDomain.upsert({
      where: {
        merchantId_environment_normalizedOrigin: {
          merchantId,
          environment: MerchantEnvironment.SANDBOX,
          normalizedOrigin: normalized.normalizedOrigin
        }
      },
      update: {},
      create: {
        merchantId,
        origin: normalized.origin,
        normalizedOrigin: normalized.normalizedOrigin,
        callbackUrl: seedConfig.merchantCallbackUrl,
        webhookUrl: seedConfig.merchantCallbackUrl,
        environment: MerchantEnvironment.SANDBOX,
        status: 'ACTIVE'
      }
    });
  }
};

const ensureMerchantApiKey = async (merchantId: string) => {
  const credential = generateMerchantCredential('SANDBOX');

  const matchingKeys = await prisma.merchantApiKey.findMany({
    where: {
      merchantId,
      label: seedConfig.merchantApiKeyLabel
    },
    orderBy: {
      createdAt: 'asc'
    },
    select: {
      id: true
    }
  });

  const [primary, ...duplicates] = matchingKeys;
  if (duplicates.length > 0) {
    await prisma.merchantApiKey.deleteMany({
      where: {
        id: {
          in: duplicates.map((row) => row.id)
        }
      }
    });
  }

  if (primary) {
    await prisma.merchantApiKey.update({
      where: { id: primary.id },
      data: {
        status: 'ACTIVE',
        clientId: credential.clientId,
        secretHash: credential.secretHash,
        secretPreview: credential.secretPreview,
        secretIv: credential.encryptedSecret.iv,
        secretAuthTag: credential.encryptedSecret.authTag,
        secretCiphertext: credential.encryptedSecret.ciphertext,
        environment: MerchantEnvironment.SANDBOX,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        rotatedAt: null,
        createdById: null
      }
    });

    return { created: false };
  }

  await prisma.merchantApiKey.create({
    data: {
      merchantId,
      label: seedConfig.merchantApiKeyLabel,
      clientId: credential.clientId,
      secretHash: credential.secretHash,
      secretPreview: credential.secretPreview,
      secretIv: credential.encryptedSecret.iv,
      secretAuthTag: credential.encryptedSecret.authTag,
      secretCiphertext: credential.encryptedSecret.ciphertext,
      status: 'ACTIVE',
      environment: MerchantEnvironment.SANDBOX
    }
  });

  return { created: true };
};

const ensureProviderCredential = async (providerId: string) => {
  const encrypted = encryptValue(seedConfig.providerCredentialValue, env.CREDENTIAL_ENCRYPTION_KEY);
  const matchingCredentials = await prisma.providerCredential.findMany({
    where: {
      providerId,
      merchantId: null,
      keyLabel: seedConfig.providerCredentialLabel
    },
    orderBy: {
      createdAt: 'asc'
    },
    select: {
      id: true
    }
  });

  const [primary, ...duplicates] = matchingCredentials;
  if (duplicates.length > 0) {
    await prisma.providerCredential.updateMany({
      where: {
        id: {
          in: duplicates.map((row) => row.id)
        }
      },
      data: {
        isActive: false
      }
    });
  }

  if (primary) {
    await prisma.providerCredential.update({
      where: { id: primary.id },
      data: {
        scope: CredentialScope.PLATFORM,
        isActive: true,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
        merchantId: null,
        createdById: null
      }
    });

    return { created: false };
  }

  await prisma.providerCredential.create({
    data: {
      providerId,
      merchantId: null,
      scope: CredentialScope.PLATFORM,
      keyLabel: seedConfig.providerCredentialLabel,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      isActive: true,
      createdById: null
    }
  });

  return { created: true };
};

const upsertInactivePlatformCredential = async (providerId: string, keyLabel: string, value: string) => {
  const encrypted = encryptValue(value, env.CREDENTIAL_ENCRYPTION_KEY);
  const existing = await prisma.providerCredential.findFirst({
    where: {
      providerId,
      merchantId: null,
      keyLabel
    },
    orderBy: {
      createdAt: 'asc'
    },
    select: {
      id: true
    }
  });

  if (existing) {
    await prisma.providerCredential.update({
      where: { id: existing.id },
      data: {
        scope: CredentialScope.PLATFORM,
        isActive: false,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
        merchantId: null,
        createdById: null
      }
    });

    return;
  }

  await prisma.providerCredential.create({
    data: {
      providerId,
      merchantId: null,
      scope: CredentialScope.PLATFORM,
      keyLabel,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      isActive: false,
      createdById: null
    }
  });
};

const main = async () => {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be configured before running the seed');
  }

  const adminPasswordHash = await bcrypt.hash(seedConfig.adminPassword, 12);

  const admin = await prisma.adminUser.upsert({
    where: { email: seedConfig.adminEmail },
    update: {
      passwordHash: adminPasswordHash,
      role: AdminRole.SUPER_ADMIN,
      isActive: true,
      refreshTokenHash: null
    },
    create: {
      email: seedConfig.adminEmail,
      passwordHash: adminPasswordHash,
      role: AdminRole.SUPER_ADMIN,
      isActive: true
    }
  });

  const merchant = await prisma.merchant.upsert({
    where: { contactEmail: seedConfig.merchantEmail },
    update: {
      name: seedConfig.merchantName,
      businessName: seedConfig.merchantBusinessName,
      contactEmail: seedConfig.merchantEmail,
      contactPhone: seedConfig.merchantPhone,
      callbackUrl: seedConfig.merchantCallbackUrl,
      status: MerchantStatus.ACTIVE,
      environment: MerchantEnvironment.SANDBOX,
      notes: 'Seed merchant for local WPA gateway development.'
    },
    create: {
      name: seedConfig.merchantName,
      businessName: seedConfig.merchantBusinessName,
      contactEmail: seedConfig.merchantEmail,
      contactPhone: seedConfig.merchantPhone,
      callbackUrl: seedConfig.merchantCallbackUrl,
      status: MerchantStatus.ACTIVE,
      environment: MerchantEnvironment.SANDBOX,
      notes: 'Seed merchant for local WPA gateway development.'
    }
  });

  await upsertMerchantDomains(merchant.id);

  const provider = await prisma.paymentProvider.upsert({
    where: { name_environment: { name: seedConfig.providerName, environment: MerchantEnvironment.SANDBOX } },
    update: {
      displayName: seedConfig.providerDisplayName,
      checkoutDisplayName: 'Card Payment (Mock)',
      checkoutDescription: 'Test payment — development only',
      brandColor: '#635BFF',
      isActive: true,
      isDevelopmentOnly: true,
      adapterType: 'mock',
      coverageType: CoverageType.LOCAL,
      regionCode: null,
      supportedCurrencies: ['USD'],
      supportedCountries: ['US', 'BD'],
      supportedRegions: [],
      excludedCountries: [],
      allowCurrencyConversion: true,
      priority: 999,
      environment: MerchantEnvironment.SANDBOX
    },
    create: {
      name: seedConfig.providerName,
      displayName: seedConfig.providerDisplayName,
      checkoutDisplayName: 'Card Payment (Mock)',
      checkoutDescription: 'Test payment — development only',
      brandColor: '#635BFF',
      isActive: true,
      isDevelopmentOnly: true,
      adapterType: 'mock',
      coverageType: CoverageType.LOCAL,
      regionCode: null,
      supportedCurrencies: ['USD'],
      supportedCountries: ['US', 'BD'],
      supportedRegions: [],
      excludedCountries: [],
      allowCurrencyConversion: true,
      priority: 999,
      environment: MerchantEnvironment.SANDBOX
    }
  });

  const epsProvider = await prisma.paymentProvider.upsert({
    where: { name_environment: { name: seedConfig.epsProviderName, environment: MerchantEnvironment.SANDBOX } },
    update: {
      displayName: seedConfig.epsProviderDisplayName,
      checkoutDisplayName: 'EPS',
      checkoutDescription: 'Pay with EPS digital wallet',
      brandColor: '#1A73E8',
      isActive: seedConfig.epsProviderActive,
      adapterType: 'redirect',
      coverageType: CoverageType.LOCAL,
      regionCode: 'SA',
      supportedCurrencies: [...seedConfig.epsProviderCurrencies],
      supportedCountries: [...seedConfig.epsProviderCountries],
      supportedRegions: ['SA'],
      excludedCountries: [],
      allowCurrencyConversion: false,
      priority: 5,
      environment: MerchantEnvironment.SANDBOX
    },
    create: {
      name: seedConfig.epsProviderName,
      displayName: seedConfig.epsProviderDisplayName,
      checkoutDisplayName: 'EPS',
      checkoutDescription: 'Pay with EPS digital wallet',
      brandColor: '#1A73E8',
      isActive: seedConfig.epsProviderActive,
      adapterType: 'redirect',
      coverageType: CoverageType.LOCAL,
      regionCode: 'SA',
      supportedCurrencies: [...seedConfig.epsProviderCurrencies],
      supportedCountries: [...seedConfig.epsProviderCountries],
      supportedRegions: ['SA'],
      excludedCountries: [],
      allowCurrencyConversion: false,
      priority: 5,
      environment: MerchantEnvironment.SANDBOX
    }
  });

  for (const p of additionalProviders) {
    await prisma.paymentProvider.upsert({
      where: { name_environment: { name: p.name, environment: p.environment } },
      update: {
        displayName: p.displayName,
        checkoutDisplayName: p.checkoutDisplayName,
        checkoutDescription: p.checkoutDescription,
        brandColor: p.brandColor,
        isActive: p.isActive,
        isDevelopmentOnly: p.isDevelopmentOnly,
        adapterType: p.adapterType,
        coverageType: p.coverageType,
        regionCode: p.regionCode,
        supportedCurrencies: p.supportedCurrencies,
        supportedCountries: p.supportedCountries,
        supportedRegions: p.supportedRegions,
        excludedCountries: p.excludedCountries,
        allowCurrencyConversion: p.allowCurrencyConversion,
        priority: p.priority
      },
      create: {
        name: p.name,
        displayName: p.displayName,
        checkoutDisplayName: p.checkoutDisplayName,
        checkoutDescription: p.checkoutDescription,
        brandColor: p.brandColor,
        isActive: p.isActive,
        isDevelopmentOnly: p.isDevelopmentOnly,
        environment: p.environment,
        adapterType: p.adapterType,
        coverageType: p.coverageType,
        regionCode: p.regionCode,
        supportedCurrencies: p.supportedCurrencies,
        supportedCountries: p.supportedCountries,
        supportedRegions: p.supportedRegions,
        excludedCountries: p.excludedCountries,
        allowCurrencyConversion: p.allowCurrencyConversion,
        priority: p.priority
      }
    });
  }

  await prisma.merchantProviderSetting.upsert({
    where: {
      merchantId_providerId: {
        merchantId: merchant.id,
        providerId: provider.id
      }
    },
    update: {
      isEnabled: true,
      priority: 1,
      currencies: ['USD'],
      countries: ['US', 'BD']
    },
    create: {
      merchantId: merchant.id,
      providerId: provider.id,
      isEnabled: true,
      priority: 1,
      currencies: ['USD'],
      countries: ['US', 'BD']
    }
  });

  // ── Country Gateway Rules ──────────────────────────────────────────────────
  const forceReseed = process.env.FORCE_COUNTRY_GATEWAY_RULE_RESEED === 'true'
  let cgr_created = 0, cgr_updated = 0, cgr_skipped = 0

  for (const rule of COUNTRY_GATEWAY_RULES_SEED) {
    const existing = await prisma.countryGatewayRule.findUnique({
      where: { countryCode: rule.countryCode },
      select: { id: true, isActive: true }
    })

    if (!existing) {
      await prisma.countryGatewayRule.create({
        data: {
          countryCode: rule.countryCode,
          countryName: rule.countryName,
          regionCode: rule.regionCode,
          regionName: rule.regionName,
          defaultCurrency: rule.defaultCurrency,
          localGatewaysEnabled: rule.localGatewaysEnabled,
          internationalGatewaysEnabled: rule.internationalGatewaysEnabled,
          internationalDisplayPolicy: rule.internationalDisplayPolicy,
          fallbackToInternationalWhenNoLocal: rule.fallbackToInternationalWhenNoLocal,
          isActive: rule.isActive,
          notes: rule.notes,
          source: 'SEED',
          isSystemSeeded: true
        }
      })
      cgr_created++
    } else if (forceReseed) {
      await prisma.countryGatewayRule.update({
        where: { countryCode: rule.countryCode },
        data: {
          countryName: rule.countryName,
          regionCode: rule.regionCode,
          regionName: rule.regionName,
          defaultCurrency: rule.defaultCurrency,
          localGatewaysEnabled: rule.localGatewaysEnabled,
          internationalGatewaysEnabled: rule.internationalGatewaysEnabled,
          internationalDisplayPolicy: rule.internationalDisplayPolicy,
          fallbackToInternationalWhenNoLocal: rule.fallbackToInternationalWhenNoLocal,
          isActive: existing.isActive,
          notes: rule.notes,
          source: 'SEED',
          isSystemSeeded: true
        }
      })
      cgr_updated++
    } else {
      cgr_skipped++
    }
  }

  const merchantKeyResult = await ensureMerchantApiKey(merchant.id);
  const providerCredentialResult = await ensureProviderCredential(provider.id);
  const epsCredentialEntries = Object.entries(seedConfig.epsProviderCredentialValues);
  for (const [keyLabel, value] of epsCredentialEntries) {
    await upsertInactivePlatformCredential(epsProvider.id, keyLabel, value);
  }

  // ── Currency Settings (ensure one record exists) ────────────────────────────
  const existingSettings = await prisma.currencySetting.findFirst();
  if (!existingSettings) {
    await prisma.currencySetting.create({
      data: {
        defaultBaseCurrency: 'USD',
        rateUpdateMode: 'MANUAL',
        rateMarkupPercent: 0,
        roundingMode: 'ROUND_2_DECIMALS',
        staleRateLimitMinutes: 60,
        isActive: true
      }
    });
  }

  // ── Sample Currency Rates ────────────────────────────────────────────────────
  const sampleRates: { base: string; quote: string; rate: number }[] = [
    { base: 'USD', quote: 'BDT', rate: 110.00 },
    { base: 'BDT', quote: 'USD', rate: 0.00909 },
    { base: 'USD', quote: 'INR', rate: 83.50 },
    { base: 'INR', quote: 'USD', rate: 0.01198 },
    { base: 'EUR', quote: 'USD', rate: 1.085 },
    { base: 'USD', quote: 'EUR', rate: 0.9217 },
    { base: 'GBP', quote: 'USD', rate: 1.265 },
    { base: 'USD', quote: 'GBP', rate: 0.7905 }
  ];

  const now = new Date();
  for (const sr of sampleRates) {
    const existing = await prisma.currencyRate.findFirst({
      where: { baseCurrency: sr.base, quoteCurrency: sr.quote, isActive: true }
    });
    if (!existing) {
      await prisma.currencyRate.create({
        data: {
          baseCurrency: sr.base,
          quoteCurrency: sr.quote,
          rate: sr.rate,
          source: RateSource.MANUAL,
          effectiveFrom: now
        }
      });
    }
  }

  // ── Purpose-Based Gateway Seed ───────────────────────────────────────────────
  const pbgResult = await seedPurposeBasedGateway(prisma, env.CREDENTIAL_ENCRYPTION_KEY);

  console.log(
    JSON.stringify(
      {
        seeded: true,
        adminEmail: admin.email,
        merchantId: merchant.id,
        provider: provider.name,
        epsProvider: epsProvider.name,
        localDevMerchantCredentialsCreated: merchantKeyResult.created,
        localDevMockProviderCredentialCreated: providerCredentialResult.created,
        localDevSecretsConfigured: true,
        countryGatewayRules: {
          total: COUNTRY_GATEWAY_RULES_SEED.length,
          created: cgr_created,
          updated: cgr_updated,
          skipped: cgr_skipped,
          forceReseed
        },
        purposeBasedGateway: pbgResult
      },
      null,
      2
    )
  );
};

main()
  .catch((error) => {
    console.error('Seed failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
