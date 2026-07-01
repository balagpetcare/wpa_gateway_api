import type { PaymentProvider } from '@prisma/client';
import type { PaymentProviderAdapter } from './base.js';
import { BKASHProviderAdapter } from './bkash.js';
import { EPSProviderAdapter } from './eps.js';
import { MockProviderAdapter } from './mock.js';
import { NAGADProviderAdapter } from './nagad.js';
import { SSLCOMMERZProviderAdapter } from './sslcommerz.js';
import { getProviderReadiness } from './readiness.js';

const registry: Partial<Record<string, () => PaymentProviderAdapter>> = {
  RAZORPAY: () => new MockProviderAdapter(),
  PAYU: () => new MockProviderAdapter(),
  CCAVENUE: () => new MockProviderAdapter(),
  STRIPE: () => new MockProviderAdapter(),
  EPS: () => new EPSProviderAdapter(),
  BKASH: () => new BKASHProviderAdapter(),
  NAGAD: () => new NAGADProviderAdapter(),
  SSLCOMMERZ: () => new SSLCOMMERZProviderAdapter()
  // TODO: Replace mock Stripe adapter with real Stripe implementation.
};

export const getProviderAdapter = (provider: Pick<PaymentProvider, 'id' | 'name' | 'displayName'>): PaymentProviderAdapter => {
  const readiness = getProviderReadiness(provider.name);
  const factory = registry[provider.name];
  if (!factory || readiness.adapterType === 'MOCK') {
    return new MockProviderAdapter();
  }

  return factory();
};
