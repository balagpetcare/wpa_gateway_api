import type { CoverageType, PaymentProvider, CountryGatewayRule, InternationalDisplayPolicy } from '@prisma/client';

// ── Minimal provider shape used inside this module ──────────────────────────

export type RoutableProvider = Pick<
  PaymentProvider,
  | 'id'
  | 'name'
  | 'displayName'
  | 'checkoutDisplayName'
  | 'checkoutDescription'
  | 'adapterType'
  | 'coverageType'
  | 'environment'
  | 'priority'
  | 'logoUrl'
  | 'iconUrl'
  | 'brandColor'
  | 'supportedCurrencies'
  | 'supportedCountries'
  | 'supportedRegions'
  | 'excludedCountries'
  | 'allowCurrencyConversion'
  | 'isDevelopmentOnly'
>;

// ── Public response shape (no credentials) ──────────────────────────────────

export interface CheckoutProvider {
  providerId: string;
  displayName: string;
  checkoutDisplayName: string | null;
  checkoutDescription: string | null;
  providerCode: string;
  adapterType: string | null;
  coverageType: CoverageType;
  environment: string;
  priorityWeight: number;
  supportedCountries: string[];
  supportedCurrencies: string[];
  logoUrl: string | null;
  iconUrl: string | null;
  brandColor: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toStringArray(json: unknown): string[] {
  return Array.isArray(json) ? (json as string[]) : [];
}

/** Returns true when the provider supports the requested currency. */
function currencyMatches(provider: RoutableProvider, currency: string): boolean {
  if (provider.allowCurrencyConversion) return true;
  return toStringArray(provider.supportedCurrencies).includes(currency);
}

/** Returns true when the provider matches the requested country/region by coverage rules. */
function coverageMatches(
  provider: RoutableProvider,
  countryCode: string,
  effectiveRegionCode: string | null
): boolean {
  const countries = toStringArray(provider.supportedCountries);
  const regions = toStringArray(provider.supportedRegions);
  const excluded = toStringArray(provider.excludedCountries);

  if (excluded.includes(countryCode)) return false;

  switch (provider.coverageType as CoverageType) {
    case 'LOCAL':
      return countries.includes(countryCode);

    case 'REGIONAL':
      if (effectiveRegionCode && regions.includes(effectiveRegionCode)) return true;
      return countries.includes(countryCode);

    case 'GLOBAL':
      // GLOBAL providers match unless they explicitly exclude this country
      return true;

    default:
      return false;
  }
}

function isLocalOrRegional(p: RoutableProvider): boolean {
  return p.coverageType === 'LOCAL' || p.coverageType === 'REGIONAL';
}

function isGlobal(p: RoutableProvider): boolean {
  return p.coverageType === 'GLOBAL';
}

function toCheckoutShape(p: RoutableProvider): CheckoutProvider {
  return {
    providerId: p.id,
    displayName: p.displayName,
    checkoutDisplayName: p.checkoutDisplayName ?? p.displayName,
    checkoutDescription: p.checkoutDescription,
    providerCode: p.name,
    adapterType: p.adapterType,
    coverageType: p.coverageType,
    environment: p.environment,
    priorityWeight: p.priority,
    supportedCountries: toStringArray(p.supportedCountries),
    supportedCurrencies: toStringArray(p.supportedCurrencies),
    logoUrl: p.logoUrl,
    iconUrl: p.iconUrl,
    brandColor: p.brandColor
  };
}

function byPriority(a: RoutableProvider, b: RoutableProvider): number {
  return a.priority - b.priority;
}

// ── Main routing function ────────────────────────────────────────────────────

export interface RoutingInput {
  countryCode: string;          // uppercase ISO 3166-1
  currency: string;             // uppercase ISO 4217
  regionCode: string | null;    // caller-supplied or derived from rule
  includeDevelopment: boolean;
  providers: RoutableProvider[];
  rule: CountryGatewayRule | null;
}

export interface RoutingResult {
  providers: CheckoutProvider[];
  appliedPolicy: InternationalDisplayPolicy | 'DEFAULT';
  countryRule: {
    countryCode: string;
    countryName: string;
    internationalDisplayPolicy: string;
    fallbackToInternationalWhenNoLocal: boolean;
    localGatewaysEnabled: boolean;
    internationalGatewaysEnabled: boolean;
  } | null;
}

export function resolveCheckoutProviders(input: RoutingInput): RoutingResult {
  const { countryCode, currency, includeDevelopment, providers, rule } = input;

  // Effective regionCode: caller-supplied → rule's regionCode → null
  const effectiveRegionCode = input.regionCode ?? rule?.regionCode ?? null;

  // Step 1: Exclude dev-only providers unless explicitly requested
  const eligible = providers.filter((p) => includeDevelopment || !p.isDevelopmentOnly);

  // Step 2: Match currency and coverage
  const matched = eligible.filter(
    (p) => currencyMatches(p, currency) && coverageMatches(p, countryCode, effectiveRegionCode)
  );

  // Step 3: Separate into local/regional vs global
  const localRegional = matched.filter(isLocalOrRegional).sort(byPriority);
  const global = matched.filter(isGlobal).sort(byPriority);

  // Step 4: Apply CountryGatewayRule display policy
  if (!rule || !rule.isActive) {
    // No active rule — return all matched sorted by priority
    return {
      providers: matched.sort(byPriority).map(toCheckoutShape),
      appliedPolicy: 'DEFAULT',
      countryRule: null
    };
  }

  // Respect gateway-enabled flags from the rule
  const allowLocal = rule.localGatewaysEnabled;
  const allowIntl = rule.internationalGatewaysEnabled;

  const filteredLocal = allowLocal ? localRegional : [];
  const filteredGlobal = allowIntl ? global : [];

  let ordered: RoutableProvider[];
  const policy = rule.internationalDisplayPolicy;

  switch (policy) {
    case 'SHOW_FIRST':
      ordered = [...filteredGlobal, ...filteredLocal];
      break;

    case 'SHOW_AFTER_LOCAL':
      ordered = [...filteredLocal, ...filteredGlobal];
      break;

    case 'HIDE_WHEN_LOCAL_EXISTS':
      if (filteredLocal.length > 0) {
        ordered = filteredLocal;
      } else if (rule.fallbackToInternationalWhenNoLocal && allowIntl) {
        ordered = filteredGlobal;
      } else {
        ordered = filteredLocal; // empty
      }
      break;

    case 'HIDE_ALWAYS':
      ordered = filteredLocal;
      break;

    default:
      ordered = [...filteredLocal, ...filteredGlobal];
  }

  return {
    providers: ordered.map(toCheckoutShape),
    appliedPolicy: policy,
    countryRule: {
      countryCode: rule.countryCode,
      countryName: rule.countryName,
      internationalDisplayPolicy: rule.internationalDisplayPolicy,
      fallbackToInternationalWhenNoLocal: rule.fallbackToInternationalWhenNoLocal,
      localGatewaysEnabled: rule.localGatewaysEnabled,
      internationalGatewaysEnabled: rule.internationalGatewaysEnabled
    }
  };
}
