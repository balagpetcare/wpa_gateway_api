import type { CurrencyRate, CurrencySetting, RoundingMode } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

export interface ConversionResult {
  from: string;
  to: string;
  originalAmount: number;
  convertedAmount: number;
  rate: string;
  markupPercent: string;
  effectiveRate: string;
  source: string;
  rateId: string;
  isStale: boolean;
  staleWarning: string | null;
  timestamp: string;
}

export function applyRounding(value: number, mode: RoundingMode): number {
  switch (mode) {
    case 'ROUND_2_DECIMALS':    return Math.round(value * 100) / 100;
    case 'ROUND_NEAREST_INTEGER': return Math.round(value);
    case 'ROUND_UP':            return Math.ceil(value);
    case 'ROUND_DOWN':          return Math.floor(value);
    case 'NONE':
    default:                    return value;
  }
}

export function computeConversion(
  amount: number,
  rate: CurrencyRate,
  settings: CurrencySetting
): ConversionResult {
  const rateVal = new Decimal(rate.rate);
  const markup = new Decimal(settings.rateMarkupPercent);
  const markupFactor = new Decimal(1).plus(markup.div(100));
  const effectiveRate = rateVal.mul(markupFactor);

  const rawConverted = new Decimal(amount).mul(effectiveRate).toNumber();
  const convertedAmount = applyRounding(rawConverted, settings.roundingMode);

  const now = new Date();
  const rateAge = (now.getTime() - rate.updatedAt.getTime()) / 60000;
  const isStale = rateAge > settings.staleRateLimitMinutes;

  return {
    from: rate.baseCurrency,
    to: rate.quoteCurrency,
    originalAmount: amount,
    convertedAmount,
    rate: rateVal.toFixed(8),
    markupPercent: markup.toFixed(2),
    effectiveRate: effectiveRate.toFixed(8),
    source: rate.source,
    rateId: rate.id,
    isStale,
    staleWarning: isStale
      ? `Rate is ${Math.round(rateAge)} minutes old (limit: ${settings.staleRateLimitMinutes} min). Conversion may not reflect current market rates.`
      : null,
    timestamp: now.toISOString()
  };
}
