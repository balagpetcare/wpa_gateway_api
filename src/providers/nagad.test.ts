import assert from 'node:assert/strict';
import { ApiError } from '../utils/errors.js';
import { getProviderAdapter } from './index.js';
import { NAGADProviderAdapter } from './nagad.js';

const adapter = new NAGADProviderAdapter();

const credentials = {
  merchantId: '6800000025',
  publicKey: 'PUBLIC_KEY_TEST',
  privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDEnyS8mEKy7YIX
jlwmUH6P4CuKK9HF4Lw5Rnl7+Fn35AfseXJ7A1UEmnxJlxfQ6gRrG2a6gds7YEY/
r3h5M7zudCq2kAI2nVkD7j+E8+kQhN6iUa3ZjPT5B8CLh9v2q7m84jfnH8e9upzA
7h0qekUlqF+elP0J0Y7V0v8oFFjENwQyM1gzdm2/zIQYRl6EU5lqj8h2uL6Sm9AK
kM0WIX1iDY4/QNJJ9hLOz+K0SCGqMWvNR5LhN2tQPAuMtp2LjhN2sUyxXqZ7x1fF
28XrZ0eSSvH/6hNU5gghVwEz0V1fDqR80SMX8wluGMvqpfWnQ1Y+6jCU8Wyrk08m
Kd+YeUkLAgMBAAECggEAE8WflBzaFuvNQKtwdnH8j74Vh5qKIAw6S0Xh8nE+CF0H
fEj2C4+u6arTQc58Yg5KzXhB6OOYm0Xs8Qh2lNok6qAHL0dBupMhMlP1VWpS7upn
ynD3p2PoCV4n4deREK7ytZC+yIJQ2BfxbRDMm+4Euf0fTNNvJGrkcujlcEAiXBCH
Cb7A9c/F1dm0aNE7pkf8f9WL5MiaKt6sfEgB5dvx8V9Ol+gx4/Hp4BHMNfW2/THL
0kCLZ5gUNR8Q/2/yGXc5d7jOUh7RkIzJ3wjlwm+M1nN1Tv1m3FdZK0PC6J5M0uBL
zk2l0Pzv+g8xqGTHspSe1q0kIN1aAvyOJy2Xxvg3YQKBgQD32rAi8+OP+20Wm+eP
RLJ0+JkrSNDtwHhL+vKhv6QwxBn9mKBiv2W0m5JtmRuWROs4LCN16yns7M1lH+gM
Kb8wt+LQE1GNnpp21CzT6xV5a8IooG2n9cASz0nr3gcRrbP2FNnvuXad87vZdysJ
s4IX7Jo85BKxM90jMXpivl+f8QKBgQDL0r3eNvXxmASmV9VVfNl6+7PgCUulxg7j
R6dfIk+GPMyktlGHx7cN9tO47cyk9NFD0xgU3CqyfPw3o7OadN/hN+8Tq31XxZxA
It6lUHL8PocbrCOk8juwuWjj1j2jV77Q6s0XrBfw9ppjA02x7m44bOaHGUfXFRQy
7jz4Vay3jQKBgQCd7ajP2F0Gc2pwZ8XtK86DLdfJX7A9S9xXQYQprho5Kj/Wki3z
g04dNiYfq8Kd7TIRq2hp/vJ9OjC2Wg7ot0o9E7l0lyPS0u1PbT0X6tNO33d3uyxi
oFy9sBy4awdbq9TegDr7ON02poNtp0zi+KjhdugX+uXfJ0JK6NwhfJp3AQKBgAup
3v6PZwAvQd5T1UqjR0n/FEiRn1JWx7pXTgZjXuT4nEpL/Jnm4b50h4cEkX9NRQCP
M9c7i6m+N7jlwmCB8WU20Yyx24sl0nIH8W2qkwRvvYShOMOdOXiw7MPdpfwHFf3u
Ph+y0wXUnKbgW1SZV47TuDRO4L5zAiQZbFtY1R0NAoGAATqdyWoE0Y+Z9Oso1VWF
FqAKVQmnp4caxh95GbTtoXMcPO3LT7sg0hQQx8nIhk7QvHImPdQv1QqPca0dR5nM
L8ZBG5j6vfCN6QVy2Hn6X7DhP5sG5cUfugIYxjlfZSn0KfPj0cvDPlHln+pjlwmM
p9YwOAr92RsvQdvl+y3RkHA=
-----END PRIVATE KEY-----`,
  baseUrl: 'https://sandbox.mynagad.com:10060',
  callbackUrl: 'https://gateway.example.com/api/v1/providers/nagad/callback'
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

export async function runNagadAdapterTests() {
  assert.equal(getProviderAdapter({ id: 'p1', name: 'NAGAD', displayName: 'Nagad' }).constructor.name, 'NAGADProviderAdapter');

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
    (async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/initialize/')) {
        return new Response(
          JSON.stringify({
            status: 'Success',
            statusCode: '000',
            paymentRefId: 'PAYREF123',
            challenge: 'server-challenge'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/complete/')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify({
            status: 'Success',
            statusCode: '000',
            callBackUrl: `https://sandbox.mynagad.com:10060/check-out/${body.challenge ?? 'PAYREF123'}`
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

      assert.equal(result.providerSessionId, 'PAYREF123');
      assert.equal(result.providerReference, 'ord_1');
      assert.equal(result.rawResponse.provider, 'NAGAD');
      assert.equal('privateKey' in result.rawResponse, false);
      assert.equal('signature' in result.rawResponse, false);
    }
  );

  await withFetchMock(
    (async () =>
      new Response(
        JSON.stringify({
          merchantId: '6800000025',
          orderId: 'ord_1',
          paymentRefId: 'PAYREF123',
          amount: '100.00',
          status: 'Success',
          statusCode: '000'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'ord_1',
        providerSessionId: 'PAYREF123',
        credentials
      });

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.providerReference, 'ord_1');
    }
  );

  await withFetchMock(
    (async () =>
      new Response(
        JSON.stringify({
          merchantId: '6800000025',
          orderId: 'ord_2',
          paymentRefId: 'PAYREF124',
          amount: '100.00',
          status: 'Pending',
          statusCode: '001'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch,
    async () => {
      const result = await adapter.verifyPayment({
        providerReference: 'ord_2',
        providerSessionId: 'PAYREF124',
        credentials
      });

      assert.equal(result.status, 'PENDING');
    }
  );

  await withFetchMock(
    (async () =>
      new Response(
        JSON.stringify({
          merchantId: '6800000025',
          orderId: 'ord_3',
          paymentRefId: 'PAYREF125',
          amount: '100.00',
          status: 'Failed',
          statusCode: '999'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch,
    async () => {
      const result = await adapter.handleWebhook({
        headers: {},
        rawBody: JSON.stringify({ payment_ref_id: 'PAYREF125', order_id: 'ord_3', status: 'Failed' }),
        credentials
      });

      assert.equal(result.status, 'FAILED');
      assert.equal(result.isVerified, true);
    }
  );

  const missingRefCallback = await adapter.handleWebhook({
    headers: {},
    rawBody: JSON.stringify({ status: 'Success' }),
    credentials
  });
  assert.equal(missingRefCallback.status, 'PENDING');
  assert.equal(missingRefCallback.isVerified, false);

  await assert.rejects(
    () =>
      adapter.refundPayment({
        providerReference: 'PAYREF126',
        credentials
      }),
    (error: unknown) => error instanceof ApiError && error.statusCode === 501
  );
}
