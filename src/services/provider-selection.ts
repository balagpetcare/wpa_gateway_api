import type { ProviderName } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/errors.js';

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toUpperCase()) : [];

const matchesCapability = (supported: string[], requested: string) => supported.length === 0 || supported.includes(requested.toUpperCase());

export const selectActiveProvider = async (input: {
  merchantId: string;
  currency: string;
  country?: string;
}) => {
  const settings = await (prisma as typeof prisma & {
    merchantProviderSetting: {
      findMany: (args: unknown) => Promise<Array<{
        currencies: unknown;
        countries: unknown;
        provider: {
          id: string;
          name: ProviderName;
          displayName: string;
          isActive: boolean;
          supportedCurrencies: unknown;
          supportedCountries: unknown;
          priority: number;
          createdAt: Date;
        };
      }>>;
    };
  }).merchantProviderSetting.findMany({
    where: {
      merchantId: input.merchantId,
      isEnabled: true,
      provider: { isActive: true }
    },
    include: { provider: true },
    orderBy: [{ priority: 'asc' }, { provider: { createdAt: 'asc' } }]
  });

  const candidates =
    settings.length > 0
      ? settings
          .filter((setting: {
            currencies: unknown;
            countries: unknown;
            provider: {
              supportedCurrencies: unknown;
              supportedCountries: unknown;
            };
          }) => {
            const providerCurrencies = readStringArray(setting.provider.supportedCurrencies);
            const providerCountries = readStringArray(setting.provider.supportedCountries);
            const merchantCurrencies = readStringArray(setting.currencies);
            const merchantCountries = readStringArray(setting.countries);

            return (
              matchesCapability(providerCurrencies, input.currency) &&
              matchesCapability(merchantCurrencies, input.currency) &&
              (!input.country ||
                (matchesCapability(providerCountries, input.country) &&
                  matchesCapability(merchantCountries, input.country)))
            );
          })
          .map((setting: { provider: Awaited<ReturnType<typeof prisma.paymentProvider.findFirstOrThrow>> }) => setting.provider)
      : await prisma.paymentProvider.findMany({
          where: { isActive: true },
          orderBy: [{ createdAt: 'asc' }]
        }).then((providers) =>
          providers.filter((provider: {
            supportedCurrencies: unknown;
            supportedCountries: unknown;
          }) => {
            const providerCurrencies = readStringArray(provider.supportedCurrencies);
            const providerCountries = readStringArray(provider.supportedCountries);
            return (
              matchesCapability(providerCurrencies, input.currency) &&
              (!input.country || matchesCapability(providerCountries, input.country))
            );
          })
        );

  const provider = candidates[0];
  if (!provider) {
    throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'No active payment provider matches merchant and currency requirements');
  }

  return provider;
};

export const listSupportedProviders = async (input: {
  merchantId: string;
  currency: string;
  country?: string;
}) => {
  const settings = await (prisma as typeof prisma & {
    merchantProviderSetting: {
      findMany: (args: unknown) => Promise<Array<{
        id: string;
        isEnabled: boolean;
        priority: number;
        currencies: unknown;
        countries: unknown;
        provider: {
          id: string;
          name: ProviderName;
          displayName: string;
          isActive: boolean;
          supportedCurrencies: unknown;
          supportedCountries: unknown;
          priority: number;
          createdAt: Date;
        };
      }>>;
    };
  }).merchantProviderSetting.findMany({
    where: {
      merchantId: input.merchantId,
      isEnabled: true,
      provider: { isActive: true }
    },
    include: { provider: true },
    orderBy: [{ priority: 'asc' }, { provider: { createdAt: 'asc' } }]
  });

  const providers =
    settings.length > 0
      ? settings
          .filter((setting) => {
            const providerCurrencies = readStringArray(setting.provider.supportedCurrencies);
            const providerCountries = readStringArray(setting.provider.supportedCountries);
            const merchantCurrencies = readStringArray(setting.currencies);
            const merchantCountries = readStringArray(setting.countries);

            return (
              matchesCapability(providerCurrencies, input.currency) &&
              matchesCapability(merchantCurrencies, input.currency) &&
              (!input.country ||
                (matchesCapability(providerCountries, input.country) &&
                  matchesCapability(merchantCountries, input.country)))
            );
          })
          .map((setting) => setting.provider)
      : await prisma.paymentProvider.findMany({
          where: { isActive: true },
          orderBy: [{ createdAt: 'asc' }]
        }).then((list) =>
          list.filter((provider) => {
            const providerCurrencies = readStringArray(provider.supportedCurrencies);
            const providerCountries = readStringArray(provider.supportedCountries);
            return (
              matchesCapability(providerCurrencies, input.currency) &&
              (!input.country || matchesCapability(providerCountries, input.country))
            );
          })
        );

  return providers;
};
