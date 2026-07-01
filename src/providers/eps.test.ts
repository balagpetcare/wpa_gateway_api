import assert from 'node:assert/strict';
import { ApiError } from '../utils/errors.js';
import { getProviderAdapter } from './index.js';
import { EPSProviderAdapter } from './eps.js';

const adapter = new EPSProviderAdapter();

const credentials = {
  username: 'eps-user',
  password: 'eps-pass',
  hashKey: 'eps-hash-key',
  merchantId: 'MERCHANT123',
  storeId: 'STORE123',
  baseUrl: 'https://sandbox-pgapi.eps.com.bd'
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

export async function runEPSAdapterTests() {
  assert.equal(getProviderAdapter({ id: 'p1', name: 'EPS', displayName: 'EPS' }).constructor.name, 'EPSProviderAdapter');

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
      if (path.endsWith('/v1/Auth/GetToken')) {
        return new Response(JSON.stringify({ token: 'eps-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path.endsWith('/v1/EPSEngine/InitializeEPS')) {
        return new Response(
          JSON.stringify({
            TransactionId: 'EPS_TXN_123',
            RedirectURL: 'https://sandbox-pgapi.eps.com.bd/pay/EPS_TXN_123'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
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

      assert.equal(result.providerSessionId, 'EPS_TXN_123');
      assert.ok(typeof result.providerReference === 'string' && result.providerReference.length > 0);
      assert.equal(result.rawResponse.provider, 'EPS');
      assert.equal('token' in result.rawResponse, false);
      assert.equal('password' in result.rawResponse, false);
      assert.equal((result.rawResponse.response as Record<string, unknown>).redirectUrl, 'https://sandbox-pgapi.eps.com.bd/pay/EPS_TXN_123');
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith('/v1/Auth/GetToken')) {
        return new Response(JSON.stringify({ token: 'eps-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path.includes('/v1/EPSEngine/CheckMerchantTransactionStatus')) {
        return new Response(
          JSON.stringify({
            MerchantTransactionId: 'MERCH_REF_1',
            EpsTransactionId: 'EPS_TXN_1',
            Status: 'Success'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'MERCH_REF_1',
        providerSessionId: 'EPS_TXN_1',
        credentials
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.providerReference, 'MERCH_REF_1');
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith('/v1/Auth/GetToken')) {
        return new Response(JSON.stringify({ token: 'eps-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path.includes('/v1/EPSEngine/CheckMerchantTransactionStatus')) {
        return new Response(
          JSON.stringify({
            MerchantTransactionId: 'MERCH_REF_2',
            EpsTransactionId: 'EPS_TXN_2',
            Status: 'Pending'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'MERCH_REF_2',
        providerSessionId: 'EPS_TXN_2',
        credentials
      });

      assert.equal(result.status, 'PENDING');
    }
  );

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith('/v1/Auth/GetToken')) {
        return new Response(JSON.stringify({ token: 'eps-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path.includes('/v1/EPSEngine/CheckMerchantTransactionStatus')) {
        return new Response(
          JSON.stringify({
            MerchantTransactionId: 'MERCH_REF_3',
            EpsTransactionId: 'EPS_TXN_3',
            Status: 'Failed'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'MERCH_REF_3',
        providerSessionId: 'EPS_TXN_3',
        credentials
      });

      assert.equal(result.status, 'FAILED');
    }
  );

  const blindCallback = await adapter.handleWebhook({
    headers: {},
    rawBody: JSON.stringify({ status: 'Success' }),
    credentials
  });
  assert.equal(blindCallback.isVerified, false);
  assert.equal(blindCallback.status, 'PENDING');

  await withFetchMock(
    (async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith('/v1/Auth/GetToken')) {
        return new Response(JSON.stringify({ token: 'eps-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path.includes('/v1/EPSEngine/CheckMerchantTransactionStatus')) {
        return new Response(
          JSON.stringify({
            MerchantTransactionId: 'MERCH_REF_4',
            EpsTransactionId: 'EPS_TXN_4',
            Status: 'Pending'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected URL ${path}`);
    }) as typeof fetch,
    async () => {
      const result = await adapter.handleWebhook({
        headers: { 'x-provider-callback-type': 'success' },
        rawBody: JSON.stringify({
          merchantTransactionId: 'MERCH_REF_4',
          epsTransactionId: 'EPS_TXN_4',
          status: 'SUCCESS'
        }),
        credentials
      });

      assert.equal(result.isVerified, true);
      assert.equal(result.status, 'PENDING');
    }
  );

  await assert.rejects(
    () =>
      adapter.refundPayment({
        providerReference: 'EPS_TXN_5',
        credentials
      }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 501
  );
}
