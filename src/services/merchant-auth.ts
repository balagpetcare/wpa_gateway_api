import type { FastifyRequest } from 'fastify';
import type { Merchant, MerchantApiKey, MerchantEnvironment, MerchantStatus, MerchantApiKeyStatus } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { decryptValue } from '../utils/encrypt.js';
import { ApiError } from '../utils/errors.js';
import { buildMerchantCanonicalPayload, verifyHmacSha256 } from '../utils/hmac.js';
import { checkAndStoreNonce } from '../middleware/replay-protection.js';

type MerchantSigningContext = {
  merchant: Pick<Merchant, 'id' | 'name' | 'callbackUrl'> & {
    status: MerchantStatus;
    environment: MerchantEnvironment;
  };
  apiKey: Pick<
    MerchantApiKey,
    | 'id'
    | 'label'
    | 'clientId'
    | 'environment'
    | 'status'
    | 'expiresAt'
    | 'secretIv'
    | 'secretAuthTag'
    | 'secretCiphertext'
  > & {
    status: MerchantApiKeyStatus;
  };
};

const buildSigningContextSelect = {
  id: true,
  name: true,
  status: true,
  environment: true,
  callbackUrl: true,
  apiKeys: {
    select: {
      id: true,
      label: true,
      clientId: true,
      environment: true,
      status: true,
      expiresAt: true,
      secretIv: true,
      secretAuthTag: true,
      secretCiphertext: true
    }
  }
} as const;

const merchantHeaderSchema = {
  merchantId: 'x-merchant-id',
  timestamp: 'x-timestamp',
  signature: 'x-signature',
  apiKey: 'x-api-key'
} as const;

const getSigningContextByClientId = async (clientId: string): Promise<MerchantSigningContext | null> => {
  const merchant = await prisma.merchant.findFirst({
    where: {
      apiKeys: {
        some: {
          clientId
        }
      }
    },
    select: buildSigningContextSelect
  });

  if (!merchant) {
    return null;
  }

  const apiKey = merchant.apiKeys.find((entry) => entry.clientId === clientId);
  if (!apiKey) {
    return null;
  }

  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      status: merchant.status,
      environment: merchant.environment,
      callbackUrl: merchant.callbackUrl
    },
    apiKey: {
      id: apiKey.id,
      label: apiKey.label,
      clientId: apiKey.clientId,
      environment: apiKey.environment,
      status: apiKey.status,
      expiresAt: apiKey.expiresAt,
      secretIv: apiKey.secretIv,
      secretAuthTag: apiKey.secretAuthTag,
      secretCiphertext: apiKey.secretCiphertext
    }
  };
};

const loadAndVerifySigningContext = async (input: {
  clientId: string;
  timestamp: string;
  signature: string;
  bodyForSignature: string;
  nonce: string;
  requestPath: string;
  requestMethod: string;
}) => {
  const timestampSeconds = Number(input.timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSeconds) || Math.abs(now - timestampSeconds) > env.HMAC_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new ApiError(401, 'TIMESTAMP_EXPIRED', 'Request timestamp outside allowed window');
  }

  const context = await getSigningContextByClientId(input.clientId);
  if (!context) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'Merchant API key is invalid');
  }

  if (context.merchant.status !== 'ACTIVE') {
    throw new ApiError(403, 'MERCHANT_INACTIVE', 'Merchant is not active');
  }

  if (context.apiKey.status !== 'ACTIVE') {
    throw new ApiError(401, 'KEY_REVOKED', 'Merchant API key has been revoked');
  }

  if (context.apiKey.expiresAt && context.apiKey.expiresAt <= new Date()) {
    throw new ApiError(401, 'KEY_EXPIRED', 'Merchant API key has expired');
  }

  const secret = decryptValue(
    {
      iv: context.apiKey.secretIv,
      authTag: context.apiKey.secretAuthTag,
      ciphertext: context.apiKey.secretCiphertext
    },
    env.CREDENTIAL_ENCRYPTION_KEY
  );

  const canonical = buildMerchantCanonicalPayload({
    method: input.requestMethod,
    path: input.requestPath,
    timestamp: input.timestamp,
    body: input.bodyForSignature
  });

  if (!verifyHmacSha256(canonical, secret, input.signature)) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'HMAC signature verification failed');
  }

  checkAndStoreNonce(context.merchant.id, input.nonce);

  return {
    merchant: context.merchant,
    apiKey: context.apiKey,
    secret
  };
};

export const verifyMerchantInitiationRequest = async (request: FastifyRequest, input: {
  clientId: string;
  timestamp: string;
  signature: string;
  nonce: string;
  bodyForSignature: string;
}) => {
  const result = await loadAndVerifySigningContext({
    ...input,
    requestMethod: request.method,
    requestPath: new URL(request.url, 'http://localhost').pathname
  });

  request.merchantAuth = {
    merchant: result.merchant,
    apiKey: {
      id: result.apiKey.id,
      label: result.apiKey.label,
      clientId: result.apiKey.clientId,
      environment: result.apiKey.environment
    },
    secret: result.secret
  };

  await prisma.merchantApiKey.update({
    where: { id: result.apiKey.id },
    data: { lastUsedAt: new Date() }
  });

  return result;
};

export const verifyMerchantApiKeyAndSignature = async (request: FastifyRequest, input: {
  merchantId: string;
  timestamp: string;
  signature: string;
  bodyForSignature: string;
}) => {
  const merchant = await prisma.merchant.findUnique({
    where: { id: input.merchantId },
    select: {
      id: true,
      name: true,
      status: true,
      environment: true,
      callbackUrl: true,
      apiKeys: {
        where: {
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        select: {
          id: true,
          label: true,
          clientId: true,
          environment: true,
          status: true,
          expiresAt: true,
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

  const headerApiKey = request.headers[merchantHeaderSchema.apiKey];
  if (typeof headerApiKey !== 'string') {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'Missing merchant authentication headers');
  }

  const matchedKey = merchant.apiKeys.find((entry) => entry.clientId === headerApiKey);
  if (!matchedKey) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'Merchant API key is invalid');
  }

  const result = await loadAndVerifySigningContext({
    clientId: matchedKey.clientId,
    timestamp: input.timestamp,
    signature: input.signature,
    bodyForSignature: input.bodyForSignature,
    nonce: input.signature,
    requestMethod: request.method,
    requestPath: new URL(request.url, 'http://localhost').pathname
  });

  request.merchantAuth = {
    merchant: result.merchant,
    apiKey: {
      id: result.apiKey.id,
      label: result.apiKey.label,
      clientId: result.apiKey.clientId,
      environment: result.apiKey.environment
    },
    secret: result.secret
  };

  await prisma.merchantApiKey.update({
    where: { id: result.apiKey.id },
    data: { lastUsedAt: new Date() }
  });
};
