import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { decryptValue } from '../utils/encrypt.js';
import { ApiError } from '../utils/errors.js';

export const getMerchantCallbackSecret = async (merchantId: string) => {
  // TODO: replace this with a dedicated merchant webhook secret so webhook
  // signing can be rotated independently from merchant API credentials.
  const apiKey = await prisma.merchantApiKey.findFirst({
    where: {
      merchantId,
      status: 'ACTIVE',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    },
    orderBy: [{ updatedAt: 'desc' }]
  });

  if (!apiKey) {
    throw new ApiError(404, 'NOT_FOUND', 'Merchant API key not found for callback signing');
  }

  return decryptValue(
    {
      iv: apiKey.secretIv,
      authTag: apiKey.secretAuthTag,
      ciphertext: apiKey.secretCiphertext
    },
    env.CREDENTIAL_ENCRYPTION_KEY
  );
};
