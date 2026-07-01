import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import type { PaymentProvider, CredentialProfile, GatewayRoutingRule, GatewayFeeRule, SettlementProfile, PaymentPurpose } from '@prisma/client';

export interface RouteResult {
  provider: {
    id: string;
    name: string;
    displayName: string;
    isActive: boolean;
    coverageType: string;
  };
  credentialProfile: {
    id: string;
    label: string;
    isActive: boolean;
    supportedPurposes: PaymentPurpose[];
    countryCodes: string[];
    currencyCodes: string[];
  } | null;
  routingRule: {
    id: string;
    countryCode: string;
    currencyCode: string;
    purpose: PaymentPurpose;
    fallbackAllowed: boolean;
  } | null;
  feeRule: {
    id: string;
    percentageFee: number;
    fixedFee: number;
    minFee: number | null;
    maxFee: number | null;
    feeBearer: string;
  } | null;
  settlementProfile: {
    id: string;
    name: string;
    payoutSchedule: string | null;
  } | null;
  feeCalculation: {
    percentageFeeAmount: string;
    fixedFeeAmount: string;
    minApplied: boolean;
    maxApplied: boolean;
    totalFee: string;
    feeBearer: string;
  } | null;
  reason: 'EXACT_PURPOSE' | 'ALL_PURPOSES' | 'SINGLE_LOCAL_GATEWAY' | 'GLOBAL_FALLBACK';
}

export class GatewayRoutingService {
  /**
   * Resolves a payment gateway and calculates fees based on the priority:
   * 1. Exact purpose routing rule (countryCode + currencyCode + purpose + environment + scope)
   * 2. ALL_PURPOSES routing rule (countryCode + currencyCode + ALL_PURPOSES + environment + scope)
   * 3. Single local gateway fallback: If the requested country has exactly one active local payment provider/credential
   *    for the requested currency and environment, use that gateway for all purposes even if no rule exists.
   * 4. Global/international fallback: Use active providers with coverageType GLOBAL or REGIONAL/INTERNATIONAL (we treat non-LOCAL as global fallback)
   *    that support requested currency and purpose.
   */
  static async resolveRoute(input: {
    merchantId: string;
    countryCode: string;
    currencyCode: string;
    purpose: PaymentPurpose;
    environment: 'SANDBOX' | 'PRODUCTION';
    amount: bigint; // standard format
  }): Promise<RouteResult> {
    const { merchantId, countryCode, currencyCode, purpose, environment, amount } = input;

    // Normalize inputs
    const ucCountry = countryCode.toUpperCase();
    const ucCurrency = currencyCode.toUpperCase();

    // Check routing rules first
    // Rule 1: Exact purpose routing rule
    // We order rules by priority asc/desc? High priority usually means higher precedence, or lower numeric value. Let's order by priority asc.
    let routingRule = await prisma.gatewayRoutingRule.findFirst({
      where: {
        countryCode: ucCountry,
        currencyCode: ucCurrency,
        purpose: purpose,
        environment,
        isActive: true,
        provider: { isActive: true },
        OR: [
          { scopeType: 'MERCHANT', scopeId: merchantId },
          { scopeType: 'PLATFORM' }
        ]
      },
      include: {
        provider: true,
        credentialProfile: {
          include: {
            settlementProfile: true
          }
        }
      },
      orderBy: [
        { scopeType: 'desc' }, // MERCHANT (M) comes before PLATFORM (P) alphabetically or custom sorting, but desc puts MERCHANT first
        { priority: 'asc' }
      ]
    });

    let reason: RouteResult['reason'] | null = null;
    if (routingRule) {
      reason = 'EXACT_PURPOSE';
    }

    // Rule 2: ALL_PURPOSES routing rule
    if (!routingRule) {
      routingRule = await prisma.gatewayRoutingRule.findFirst({
        where: {
          countryCode: ucCountry,
          currencyCode: ucCurrency,
          purpose: 'ALL_PURPOSES',
          environment,
          isActive: true,
          provider: { isActive: true },
          OR: [
            { scopeType: 'MERCHANT', scopeId: merchantId },
            { scopeType: 'PLATFORM' }
          ]
        },
        include: {
          provider: true,
          credentialProfile: {
            include: {
              settlementProfile: true
            }
          }
        },
        orderBy: [
          { scopeType: 'desc' },
          { priority: 'asc' }
        ]
      });

      if (routingRule) {
        reason = 'ALL_PURPOSES';
      }
    }

    let resolvedProvider: any = routingRule?.provider || null;
    let resolvedProfile: any = routingRule?.credentialProfile || null;

    // Rule 3: Single local gateway fallback
    // "If the requested country has exactly one active local payment provider/credential for the requested currency and environment, use that gateway for all purposes"
    if (!resolvedProvider) {
      // Find all active local provider profiles for the requested country, currency, and environment
      // A provider is local if coverageType is LOCAL. We must also check supportedCountries/supportedCurrencies in the PaymentProvider model,
      // or check the CredentialProfile itself (e.g. countryCodes, currencyCodes).
      // Let's find all active credential profiles or provider credentials for this provider.
      // Wait, credential profiles have `countryCodes`, `currencyCodes`. Let's search for profiles that match.
      const activeProfiles = await prisma.credentialProfile.findMany({
        where: {
          environment,
          isActive: true,
          countryCodes: { has: ucCountry },
          currencyCodes: { has: ucCurrency },
          provider: {
            isActive: true,
            coverageType: 'LOCAL'
          },
          OR: [
            { scope: 'MERCHANT', merchantId },
            { scope: 'PLATFORM' }
          ]
        },
        include: {
          provider: true,
          settlementProfile: true
        }
      });

      // Deduplicate by provider to see if there is exactly one active local payment provider
      const providerMap = new Map<string, { profile: any; provider: any }>();
      for (const profile of activeProfiles) {
        providerMap.set(profile.provider.id, { profile, provider: profile.provider });
      }

      if (providerMap.size === 1) {
        const unique = Array.from(providerMap.values())[0];
        if (unique) {
          resolvedProvider = unique.provider;
          resolvedProfile = unique.profile;
          reason = 'SINGLE_LOCAL_GATEWAY';
        }
      }
    }

    // Rule 4: Global/international fallback
    // Use active providers with coverageType GLOBAL or REGIONAL/INTERNATIONAL (which maps to REGIONAL or GLOBAL) that support the requested currency and purpose.
    if (!resolvedProvider) {
      // Find active profiles where the provider has coverageType GLOBAL or REGIONAL
      // and supportedPurposes contains requested purpose (or ALL_PURPOSES)
      // and currencyCodes contains requested currency
      const globalProfiles = await prisma.credentialProfile.findMany({
        where: {
          environment,
          isActive: true,
          currencyCodes: { has: ucCurrency },
          supportedPurposes: { hasSome: [purpose, 'ALL_PURPOSES'] },
          provider: {
            isActive: true,
            coverageType: { in: ['GLOBAL', 'REGIONAL'] }
          },
          OR: [
            { scope: 'MERCHANT', merchantId },
            { scope: 'PLATFORM' }
          ]
        },
        include: {
          provider: true,
          settlementProfile: true
        },
        orderBy: {
          priority: 'asc'
        }
      });

      // Deduplicate by provider
      const providerMap = new Map<string, { profile: any; provider: any }>();
      for (const profile of globalProfiles) {
        if (!providerMap.has(profile.provider.id)) {
          providerMap.set(profile.provider.id, { profile, provider: profile.provider });
        }
      }

      if (providerMap.size > 0) {
        // Pick the first one based on profile priority
        const chosen = Array.from(providerMap.values())[0];
        if (chosen) {
          resolvedProvider = chosen.provider;
          resolvedProfile = chosen.profile;
          reason = 'GLOBAL_FALLBACK';
        }
      }
    }

    if (!resolvedProvider || !reason) {
      throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'No payment gateway available for this country, currency, and purpose.');
    }

    if (env.REQUIRE_PROVIDER_VERIFICATION_FOR_CHECKOUT === 'true' && resolvedProfile) {
      const isVerified = environment === 'PRODUCTION' ? Boolean(resolvedProfile.liveVerifiedAt) : Boolean(resolvedProfile.sandboxVerifiedAt);
      if (!isVerified) {
        throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Selected credential profile has not been verified for checkout.');
      }
    }

    // Find Fee Rule
    // Grouped by providerId and optionally credentialProfileId, countryCode, currencyCode, purpose, environment
    // Ordered by specificity (most specific first)
    const feeRules = await prisma.gatewayFeeRule.findMany({
      where: {
        providerId: resolvedProvider.id,
        environment,
        isActive: true,
        purpose: { in: [purpose, 'ALL_PURPOSES'] },
        OR: [
          { credentialProfileId: resolvedProfile?.id },
          { credentialProfileId: null }
        ],
        AND: [
          { OR: [{ countryCode: ucCountry }, { countryCode: null }] },
          { OR: [{ currencyCode: ucCurrency }, { currencyCode: null }] }
        ]
      }
    });

    // Score fee rules to pick the most specific one:
    // 1. exact credential + country + currency + purpose
    // 2. credential + country + currency + ALL_PURPOSES
    // etc.
    let bestFeeRule: GatewayFeeRule | null = null;
    let bestScore = -1;

    for (const rule of feeRules) {
      let score = 0;
      if (rule.credentialProfileId) score += 1000;
      if (rule.countryCode) score += 100;
      if (rule.currencyCode) score += 10;
      if (rule.purpose === purpose) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestFeeRule = rule;
      }
    }

    // Calculate fee
    let feeCalculation: RouteResult['feeCalculation'] = null;
    if (bestFeeRule) {
      const amtNum = Number(amount);
      const percentageFee = Number(bestFeeRule.percentageFee);
      const fixedFee = Number(bestFeeRule.fixedFee);
      const minFee = bestFeeRule.minFee ? Number(bestFeeRule.minFee) : null;
      const maxFee = bestFeeRule.maxFee ? Number(bestFeeRule.maxFee) : null;

      let percentageFeeAmount = (amtNum * percentageFee) / 100;
      let totalFee = percentageFeeAmount + fixedFee;

      let minApplied = false;
      let maxApplied = false;

      if (minFee !== null && totalFee < minFee) {
        totalFee = minFee;
        minApplied = true;
      }
      if (maxFee !== null && totalFee > maxFee) {
        totalFee = maxFee;
        maxApplied = true;
      }

      feeCalculation = {
        percentageFeeAmount: percentageFeeAmount.toFixed(4),
        fixedFeeAmount: fixedFee.toFixed(4),
        minApplied,
        maxApplied,
        totalFee: totalFee.toFixed(4),
        feeBearer: bestFeeRule.feeBearer
      };
    }

    return {
      provider: {
        id: resolvedProvider.id,
        name: resolvedProvider.name,
        displayName: resolvedProvider.displayName,
        isActive: resolvedProvider.isActive,
        coverageType: resolvedProvider.coverageType
      },
      credentialProfile: resolvedProfile ? {
        id: resolvedProfile.id,
        label: resolvedProfile.label,
        isActive: resolvedProfile.isActive,
        supportedPurposes: resolvedProfile.supportedPurposes,
        countryCodes: resolvedProfile.countryCodes,
        currencyCodes: resolvedProfile.currencyCodes
      } : null,
      routingRule: routingRule ? {
        id: routingRule.id,
        countryCode: routingRule.countryCode,
        currencyCode: routingRule.currencyCode,
        purpose: routingRule.purpose,
        fallbackAllowed: routingRule.fallbackAllowed
      } : null,
      feeRule: bestFeeRule ? {
        id: bestFeeRule.id,
        percentageFee: Number(bestFeeRule.percentageFee),
        fixedFee: Number(bestFeeRule.fixedFee),
        minFee: bestFeeRule.minFee ? Number(bestFeeRule.minFee) : null,
        maxFee: bestFeeRule.maxFee ? Number(bestFeeRule.maxFee) : null,
        feeBearer: bestFeeRule.feeBearer
      } : null,
      settlementProfile: resolvedProfile?.settlementProfile ? {
        id: resolvedProfile.settlementProfile.id,
        name: resolvedProfile.settlementProfile.name,
        payoutSchedule: resolvedProfile.settlementProfile.payoutSchedule
      } : null,
      feeCalculation,
      reason
    };
  }
}
