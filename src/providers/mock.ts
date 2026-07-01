import { randomUUID } from 'node:crypto';
import { verifyHmacSha256 } from '../utils/hmac.js';
import type {
  PaymentProviderAdapter,
  ProviderCreatePaymentInput,
  ProviderCreatePaymentResult,
  ProviderHandleWebhookInput,
  ProviderHandleWebhookResult,
  ProviderRefundPaymentInput,
  ProviderRefundPaymentResult,
  ProviderVerifyPaymentInput,
  ProviderVerifyPaymentResult
} from './base.js';

export class MockProviderAdapter implements PaymentProviderAdapter {
  async createPayment(input: ProviderCreatePaymentInput): Promise<ProviderCreatePaymentResult> {
    const providerSessionId = `mock_sess_${randomUUID()}`;
    const providerReference = `mock_ref_${randomUUID()}`;

    return {
      providerSessionId,
      providerReference,
      checkoutToken: `mock_checkout_${randomUUID()}`,
      rawResponse: {
        provider: 'mock',
        sessionId: providerSessionId,
        reference: providerReference,
        acceptedAmount: input.amountDecimal,
        acceptedAmountMinor: input.amountMinor,
        acceptedCurrency: input.currency,
        acceptedCountry: input.country ?? null
      }
    };
  }

  async verifyPayment(input: ProviderVerifyPaymentInput): Promise<ProviderVerifyPaymentResult> {
    return {
      status: 'PENDING',
      providerReference: input.providerReference,
      rawResponse: {
        provider: 'mock',
        verification: 'not-implemented'
      }
    };
  }

  async handleWebhook(input: ProviderHandleWebhookInput): Promise<ProviderHandleWebhookResult> {
    const parsed = JSON.parse(input.rawBody) as {
      eventId?: string;
      providerReference?: string;
      providerSessionId?: string;
      status?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
      merchantId?: string;
    };
    const headerSignature = input.headers['x-mock-signature'];
    const webhookSecret = input.credentials.webhook_secret;
    const isVerified =
      typeof headerSignature === 'string' && webhookSecret
        ? verifyHmacSha256(input.rawBody, webhookSecret, headerSignature)
        : true;

    return {
      isVerified,
      providerEventId: parsed.eventId ?? `mock_event_${randomUUID()}`,
      merchantId: parsed.merchantId,
      providerReference: parsed.providerReference,
      providerSessionId: parsed.providerSessionId,
      status: parsed.status ?? 'PENDING',
      payload: {
        provider: 'mock',
        ...parsed
      }
    };
  }

  async refundPayment(input: ProviderRefundPaymentInput): Promise<ProviderRefundPaymentResult> {
    return {
      refundReference: `mock_refund_${randomUUID()}`,
      status: 'PENDING',
      rawResponse: {
        provider: 'mock',
        providerReference: input.providerReference,
        refundAmount: input.amount ?? null
      }
    };
  }
}
