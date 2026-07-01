import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { decryptValue } from '../utils/encrypt.js';
import { ApiError } from '../utils/errors.js';
import { buildMerchantCanonicalPayload, verifyHmacSha256 } from '../utils/hmac.js';
import { checkAndStoreNonce } from './replay-protection.js';

const merchantHeaderSchema = {
  merchantId: 'x-merchant-id',
  timestamp: 'x-timestamp',
  signature: 'x-signature',
  apiKey: 'x-api-key'
} as const;

export const requireMerchantHmac = async (request: FastifyRequest) => {
  const merchantId = request.headers[merchantHeaderSchema.merchantId];
  const timestamp = request.headers[merchantHeaderSchema.timestamp];
  const signature = request.headers[merchantHeaderSchema.signature];
  const apiKey = request.headers[merchantHeaderSchema.apiKey];

  if (
    typeof merchantId !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof signature !== 'string' ||
    typeof apiKey !== 'string'
  ) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'Missing merchant authentication headers');
  }

  const timestampSeconds = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSeconds) || Math.abs(now - timestampSeconds) > env.HMAC_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new ApiError(401, 'TIMESTAMP_EXPIRED', 'Request timestamp outside allowed window');
  }

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      id: true,
      name: true,
      callbackUrl: true,
      status: true,
      apiKeys: {
        where: {
          clientId: apiKey,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        select: {
          id: true,
          label: true,
          clientId: true,
          environment: true,
          secretIv: true,
          secretAuthTag: true,
          secretCiphertext: true
        }
      }
    }
  });

  if (!merchant || merchant.status !== 'ACTIVE') {
    throw new ApiError(403, 'MERCHANT_INACTIVE', 'Merchant is not active');
  }

  const matchedKey = merchant.apiKeys[0];

  if (!matchedKey) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'Merchant API key is invalid');
  }

  const secret = decryptValue(
    {
      iv: matchedKey.secretIv,
      authTag: matchedKey.secretAuthTag,
      ciphertext: matchedKey.secretCiphertext
    },
    env.CREDENTIAL_ENCRYPTION_KEY
  );

  const canonical = buildMerchantCanonicalPayload({
    method: request.method,
    path: new URL(request.url, 'http://localhost').pathname,
    timestamp,
    body: request.body ? JSON.stringify(request.body) : ''
  });

  if (!verifyHmacSha256(canonical, secret, signature)) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'HMAC signature verification failed');
  }

  checkAndStoreNonce(merchantId, signature);

  request.merchantAuth = {
    merchant,
    apiKey: { id: matchedKey.id, label: matchedKey.label, clientId: matchedKey.clientId, environment: matchedKey.environment },
    secret
  };

  await prisma.merchantApiKey.update({
    where: { id: matchedKey.id },
    data: { lastUsedAt: new Date() }
  });
};
