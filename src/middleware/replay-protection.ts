import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { nonceStore } from '../services/nonce-store.js';

/**
 * Check that the (merchantId, token) pair has not been seen before.
 * Throws REPLAY_DETECTED if it has, otherwise records it for future checks.
 */
export const checkAndStoreNonce = (merchantId: string, token: string): void => {
  const key = `${merchantId}:${token}`;

  if (nonceStore.has(key)) {
    throw new ApiError(401, 'REPLAY_DETECTED', 'Replayed request signature detected');
  }

  nonceStore.set(key, env.NONCE_TTL_SECONDS * 1_000);
};
