import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (payload: string | Buffer) =>
  createHash('sha256').update(payload).digest('hex');

const normalizeForJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForJson(entry));
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeForJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }

  return value;
};

export const stableJsonStringify = (value: unknown) => JSON.stringify(normalizeForJson(value));

export const buildMerchantCanonicalPayload = (input: {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}) => `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${sha256Hex(input.body)}`;

export const signHmacSha256 = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('hex');

export const verifyHmacSha256 = (payload: string, secret: string, signature: string) => {
  const expected = Buffer.from(signHmacSha256(payload, secret), 'hex');
  const received = Buffer.from(signature, 'hex');

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
};
