import assert from 'node:assert/strict';
import { ApiError } from '../utils/errors.js';
import { getProviderAdapter } from './index.js';
import { BKASHProviderAdapter } from './bkash.js';

const adapter = new BKASHProviderAdapter();

const credentials = {
  appKey: 'bkash-app-key',
  appSecret: 'bkash-app-secret',
  username: 'bkash-user',
  password: 'bkash-pass',
  baseUrl: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout'
};

const tokenFailureCredentials = {
  ...credentials,
  baseUrl: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout-fail'
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

export async function runBkashAdapterTests() {
  assert.equal(getProviderAdapter({ id: 'p1', name: 'BKASH', displayName: 'bKash' }).constructor.name, 'BKASHProviderAdapter');

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
    (async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/token/grant')) {
        return new Response(
          JSON.stringify({
            statusCode: '2001',
            statusMessage: 'Backend service down'
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        () =>
          adapter.createPayment({
            sessionId: 'sess_2',
            merchantId: 'm1',
            orderId: 'ord_2',
            amount: 100,
            amountMinor: '100',
            amountDecimal: '1.00',
            currency: 'BDT',
            purpose: 'DONATION',
            customer: { name: 'Jane', email: 'jane@example.com', phone: '01700000000' },
            successUrl: 'https://gateway.example.com/success',
            cancelUrl: 'https://gateway.example.com/cancel',
            callbackUrl: 'https://gateway.example.com/callback',
            credentials: tokenFailureCredentials
          }),
        (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE'
      );
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/token/grant')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            id_token: 'secure-token'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/create')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            statusMessage: 'Successful',
            paymentID: 'PAYMENT123',
            bkashURL: 'https://sandbox.bka.sh/checkout/PAYMENT123'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.createPayment({
        sessionId: 'sess_3',
        merchantId: 'm1',
        orderId: 'ord_3',
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

      assert.equal(result.providerSessionId, 'PAYMENT123');
      assert.equal(result.providerReference, 'ord_3');
      assert.equal(result.rawResponse.provider, 'BKASH');
      assert.equal('id_token' in result.rawResponse, false);
      assert.equal('appSecret' in result.rawResponse, false);
      assert.equal('password' in result.rawResponse, false);
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/token/grant')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            id_token: 'secure-token-verify-success'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/execute')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            transactionStatus: 'Completed',
            paymentID: 'PAYMENT124',
            trxID: 'TRX124',
            merchantInvoiceNumber: 'ord_4'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'ord_4',
        providerSessionId: 'PAYMENT124',
        credentials: { ...credentials, baseUrl: `${credentials.baseUrl}-verify-success` }
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.providerReference, 'TRX124');
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/token/grant')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            id_token: 'secure-token-verify-query'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/execute')) {
        return new Response(
          JSON.stringify({
            statusCode: '2023',
            statusMessage: 'Payment already completed'
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/payment/status')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            transactionStatus: 'Completed',
            paymentID: 'PAYMENT125',
            trxID: 'TRX125',
            merchantInvoiceNumber: 'ord_5'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'ord_5',
        providerSessionId: 'PAYMENT125',
        credentials: { ...credentials, baseUrl: `${credentials.baseUrl}-verify-query` }
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.providerReference, 'TRX125');
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/token/grant')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            id_token: 'secure-token-verify-pending'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/execute')) {
        return new Response(
          JSON.stringify({
            statusCode: '0000',
            transactionStatus: 'Initiated',
            paymentID: 'PAYMENT126',
            merchantInvoiceNumber: 'ord_6'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'ord_6',
        providerSessionId: 'PAYMENT126',
        credentials: { ...credentials, baseUrl: `${credentials.baseUrl}-verify-pending` }
      });

      assert.equal(result.status, 'PENDING');
    }
  );

  await assert.rejects(
    () =>
      adapter.refundPayment({
        providerReference: 'PAYMENT127',
        credentials
      }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 501
  );
}
