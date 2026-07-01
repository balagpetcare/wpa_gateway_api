import type { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { decryptValue } from '../utils/encrypt.js';

export type DecryptedProviderCredentials = Record<string, string>;

export const getDecryptedProviderCredentials = async (input: {
  providerId: string;
  merchantId: string;
}): Promise<DecryptedProviderCredentials> => {
  const credentials = await prisma.providerCredential.findMany({
    where: {
      providerId: input.providerId,
      isActive: true,
      OR: [{ merchantId: input.merchantId }, { merchantId: null }]
    },
    orderBy: [{ merchantId: 'desc' }, { createdAt: 'desc' }]
  });

  const resolved = new Map<string, string>();
  for (const credential of credentials) {
    if (resolved.has(credential.keyLabel)) {
      continue;
    }

    resolved.set(
      credential.keyLabel,
      decryptValue(
        {
          iv: credential.iv,
          authTag: credential.authTag,
          ciphertext: credential.ciphertext
        },
        env.CREDENTIAL_ENCRYPTION_KEY
      )
    );
  }

  return Object.fromEntries(resolved) as Prisma.JsonObject as DecryptedProviderCredentials;
};

// Decrypts credentials for a provider, preferring a CredentialProfile when available.
// Falls back to legacy ProviderCredential rows when no profile is found.
export const getDecryptedCredentialsForSession = async (input: {
  providerId: string;
  merchantId: string;
  credentialProfileId?: string | null;
}): Promise<DecryptedProviderCredentials> => {
  if (input.credentialProfileId) {
    const profile = await prisma.credentialProfile.findUnique({
      where: { id: input.credentialProfileId },
      select: { encryptedSecrets: true, isActive: true }
    });

    if (profile?.isActive && profile.encryptedSecrets) {
      const raw = profile.encryptedSecrets as { iv: string; authTag: string; ciphertext: string };
      try {
        const json = decryptValue(raw, env.CREDENTIAL_ENCRYPTION_KEY);
        return JSON.parse(json) as DecryptedProviderCredentials;
      } catch {
        // Fall through to legacy credentials on decryption error
      }
    }
  }

  return getDecryptedProviderCredentials({ providerId: input.providerId, merchantId: input.merchantId });
};
