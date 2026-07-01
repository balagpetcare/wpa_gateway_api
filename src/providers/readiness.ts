import type { PaymentProvider, ProviderName } from '@prisma/client';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

export type ProviderAdapterType = 'REAL' | 'MOCK';

export interface ProviderReadinessMetadata {
  providerCode: ProviderName;
  adapterType: ProviderAdapterType;
  supportsPayment: boolean;
  supportsVerify: boolean;
  supportsWebhook: boolean;
  supportsRefund: boolean;
  supportsPayout: boolean;
  productionReady: boolean;
  notes: string[];
}

const PROVIDER_READINESS: Record<ProviderName, ProviderReadinessMetadata> = {
  EPS: {
    providerCode: 'EPS',
    adapterType: 'REAL',
    supportsPayment: true,
    supportsVerify: true,
    supportsWebhook: true,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: true,
    notes: ['Webhook support is partial and still depends on provider callback coverage.', 'Refunds remain manual.']
  },
  BKASH: {
    providerCode: 'BKASH',
    adapterType: 'REAL',
    supportsPayment: true,
    supportsVerify: true,
    supportsWebhook: true,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: true,
    notes: ['Refunds remain manual until a real BKASH refund adapter is implemented.']
  },
  RAZORPAY: {
    providerCode: 'RAZORPAY',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Currently routed to MockProviderAdapter.']
  },
  PAYU: {
    providerCode: 'PAYU',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Currently routed to MockProviderAdapter.']
  },
  CCAVENUE: {
    providerCode: 'CCAVENUE',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Currently routed to MockProviderAdapter.']
  },
  STRIPE: {
    providerCode: 'STRIPE',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Currently routed to MockProviderAdapter.']
  },
  NAGAD: {
    providerCode: 'NAGAD',
    adapterType: 'REAL',
    supportsPayment: true,
    supportsVerify: true,
    supportsWebhook: true,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: true,
    notes: ['Callback authenticity is enforced through provider status verification.', 'Refunds remain manual.']
  },
  SSLCOMMERZ: {
    providerCode: 'SSLCOMMERZ',
    adapterType: 'REAL',
    supportsPayment: true,
    supportsVerify: true,
    supportsWebhook: true,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: true,
    notes: ['Hosted checkout and validation/IPN verification are supported.', 'Refunds remain manual.']
  },
  CASHFREE: {
    providerCode: 'CASHFREE',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Adapter not implemented yet.']
  },
  PAYPAL: {
    providerCode: 'PAYPAL',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Adapter not implemented yet.']
  },
  AUTHORIZE_NET: {
    providerCode: 'AUTHORIZE_NET',
    adapterType: 'MOCK',
    supportsPayment: false,
    supportsVerify: false,
    supportsWebhook: false,
    supportsRefund: false,
    supportsPayout: false,
    productionReady: false,
    notes: ['Adapter not implemented yet.']
  }
};

const inferProductionContext = (provider: Pick<PaymentProvider, 'environment' | 'isDevelopmentOnly'>) =>
  env.NODE_ENV === 'production' || provider.environment === 'PRODUCTION' || !provider.isDevelopmentOnly;

export const getProviderReadiness = (providerName: ProviderName): ProviderReadinessMetadata => PROVIDER_READINESS[providerName];

export const attachProviderReadiness = <T extends Pick<PaymentProvider, 'name'>>(provider: T) => ({
  ...provider,
  readiness: getProviderReadiness(provider.name)
});

export const attachCheckoutProviderReadiness = <T extends { providerCode: string }>(provider: T) => ({
  ...provider,
  readiness: getProviderReadiness(provider.providerCode as ProviderName)
});

export const assertProviderReadyForPayments = (provider: Pick<PaymentProvider, 'id' | 'name' | 'displayName' | 'environment' | 'isDevelopmentOnly'>) => {
  const readiness = getProviderReadiness(provider.name);
  const isProductionLike = inferProductionContext(provider);
  const allowMock = env.ALLOW_MOCK_PROVIDERS === 'true';
  const allowIncomplete = env.ALLOW_INCOMPLETE_PROVIDERS === 'true';

  if (!readiness.supportsPayment) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', `${provider.displayName} does not support payment initiation yet.`);
  }

  if (readiness.adapterType === 'MOCK' && !allowMock) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', `${provider.displayName} is using a mock adapter and cannot accept live payments.`);
  }

  if (isProductionLike && !readiness.productionReady && !allowIncomplete) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', `${provider.displayName} is not production-ready for checkout yet.`);
  }
};
