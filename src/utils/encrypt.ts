import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';

export type EncryptedValue = {
  iv: string;
  authTag: string;
  ciphertext: string;
};

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const deriveKey = (masterKey: string) => {
  if (!masterKey) {
    throw new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Credential encryption key is not configured');
  }

  return createHash('sha256').update(masterKey).digest();
};

export const encryptValue = (plaintext: string, masterKey: string): EncryptedValue => {
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(masterKey);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
};

export const decryptValue = (value: EncryptedValue, masterKey: string): string => {
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
};
