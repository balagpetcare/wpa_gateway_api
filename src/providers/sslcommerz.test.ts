import assert from 'node:assert/strict';
import { SSLCOMMERZProviderAdapter } from './sslcommerz.js';
import { ApiError } from '../utils/errors.js';
import { getProviderAdapter } from './index.js';

const adapter = new SSLCOMMERZProviderAdapter();

const credentials = {
  storeId: 'testbox',
  storePassword: 'secret-pass',
  baseUrl: 'https://sandbox.sslcommerz.com',
  ipnUrl: 'https://gateway.example.com/api/v1/providers/sslcommerz/ipn'
};

const withFetchMock = async (implementation: typeof fetch, fn: () => Promise<void>) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

export async function runSSLCommerzAdapterTests() {
  assert.equal(getProviderAdapter({ id: 'p1', name: 'SSLCOMMERZ', displayName: 'SSLCommerz' }).constructor.name, 'SSLCOMMERZProviderAdapter');

  await assert.rejects(
    () =>
      adapter.createPayment({
        sessionId: 'sess_1',
        merchantId: 'm1',
        orderId: 'ord_1',
        amount: 100,
        amountMinor: '100',
        amountDecimal: '1.00',
        currency: 'BDT',
        purpose: 'DONATION',
        customer: { name: 'Jane', email: 'jane@example.com', phone: '01700000000' },
        successUrl: 'https://gateway.example.com/success',
        cancelUrl: 'https://gateway.example.com/cancel',
        callbackUrl: 'https://gateway.example.com/callback',
        credentials: {}
      }),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_NOT_CONFIGURED'
  );

  await withFetchMock(
    async () =>
      new Response(
        JSON.stringify({
          status: 'SUCCESS',
          sessionkey: 'SESSION123',
          GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/test'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      const result = await adapter.createPayment({
        sessionId: 'sess_1',
        merchantId: 'm1',
        orderId: 'ord_1',
        amount: 100,
        amountMinor: '100',
        amountDecimal: '1.00',
        currency: 'BDT',
        purpose: 'DONATION',
        customer: { name: 'Jane', email: 'jane@example.com', phone: '01700000000' },
        successUrl: 'https://gateway.example.com/success',
        cancelUrl: 'https://gateway.example.com/cancel',
        callbackUrl: 'https://gateway.example.com/callback',
        credentials
      });

      assert.equal(result.providerSessionId, 'SESSION123');
      assert.equal(result.providerReference, 'ord_1');
      assert.equal(result.rawResponse.provider, 'SSLCOMMERZ');
      assert.equal('storePassword' in result.rawResponse, false);
    }
  );

  await withFetchMock(
    async () =>
      new Response(
        JSON.stringify({
          status: 'VALIDATED',
          val_id: 'VAL123',
          tran_id: 'TRX123',
          amount: '100.00',
          currency: 'BDT'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'TRX123',
        providerTransactionId: 'VAL123',
        credentials
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.providerReference, 'TRX123');
    }
  );

  await withFetchMock(
    async () =>
      new Response(
        JSON.stringify({
          APIConnect: 'DONE',
          element: [
            {
              status: 'FAILED',
              tran_id: 'TRX124',
              sessionkey: 'SESSION124'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'TRX124',
        providerSessionId: 'SESSION124',
        credentials
      });

      assert.equal(result.status, 'FAILED');
    }
  );

  await withFetchMock(
    async () =>
      new Response(
        JSON.stringify({
          APIConnect: 'DONE',
          element: [
            {
              status: 'PENDING',
              tran_id: 'TRX125',
              sessionkey: 'SESSION125'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      const result = await adapter.handleWebhook({
        headers: {},
        rawBody: JSON.stringify({ tran_id: 'TRX125', sessionkey: 'SESSION125', status: 'PENDING' }),
        credentials
      });

      assert.equal(result.isVerified, false);
      assert.equal(result.status, 'PENDING');
    }
  );

  await assert.rejects(
    () =>
      adapter.refundPayment({
        providerReference: 'TRX126',
        credentials
      }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 501
  );
}
