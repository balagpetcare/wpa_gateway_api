import { createHash, randomBytes } from 'node:crypto';
import type { Merchant, MerchantApiKey, MerchantDomain, Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { encryptValue } from '../../utils/encrypt.js';

export const merchantStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export const merchantEnvironments = ['SANDBOX', 'PRODUCTION'] as const;
export const merchantApiKeyStatuses = ['ACTIVE', 'REVOKED'] as const;
export const merchantDomainStatuses = ['ACTIVE', 'INACTIVE'] as const;

const phoneRegex = /^\+?[0-9().\-\s]{7,20}$/;
const hostnameRegex = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^(localhost|127\.0\.0\.1)$/i;

export const merchantIdSchema = z.object({
  id: z.string().min(1)
});

export const merchantApiKeyIdSchema = z.object({
  id: z.string().min(1)
});

export const merchantDomainIdSchema = z.object({
  id: z.string().min(1)
});

export const merchantListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().optional(),
  status: z.enum(merchantStatuses).optional(),
  environment: z.enum(merchantEnvironments).optional()
});

export const merchantCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  business_name: z.string().trim().min(2).max(160),
  contact_email: z.email(),
  contact_phone: z.string().trim().regex(phoneRegex, 'Invalid phone number').optional().or(z.literal('')).transform((value) => value || undefined),
  status: z.enum(merchantStatuses).default('ACTIVE'),
  environment: z.enum(merchantEnvironments).default('SANDBOX'),
  notes: z.string().trim().max(5000).optional().or(z.literal('')).transform((value) => value || undefined)
});

export const merchantUpdateSchema = merchantCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one field must be provided'
);

export const merchantStatusUpdateSchema = z.object({
  status: z.enum(merchantStatuses)
});

export const merchantApiKeyCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  environment: z.enum(merchantEnvironments).default('SANDBOX'),
  expires_at: z.string().datetime().optional()
});

export const merchantApiKeyRotateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  expires_at: z.string().datetime().optional()
});

export const merchantDomainCreateSchema = z.object({
  origin: z.string().trim().min(1).max(255),
  callback_url: z.url().optional().or(z.literal('')).transform((value) => value || undefined),
  webhook_url: z.url().optional().or(z.literal('')).transform((value) => value || undefined),
  status: z.enum(merchantDomainStatuses).default('ACTIVE'),
  environment: z.enum(merchantEnvironments).default('SANDBOX')
});

export const merchantDomainUpdateSchema = merchantDomainCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one field must be provided'
);

export const adminRoutePaths = (path: string) => [path, `/api/v1${path}`];

export const parseOptionalDate = (value?: string) => (value ? new Date(value) : undefined);

export const normalizeOrigin = (value: string) => {
  const trimmed = value.trim().toLowerCase();

  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Unsupported origin protocol');
    }

    return {
      origin: url.origin.toLowerCase(),
      normalizedOrigin: url.hostname.toLowerCase()
    };
  } catch {
    if (!hostnameRegex.test(trimmed)) {
      throw new Error('Origin must be a valid hostname or http/https origin');
    }

    return {
      origin: trimmed,
      normalizedOrigin: trimmed
    };
  }
};

export const assertUrlMatchesOrigin = (urlValue: string | undefined, normalizedOrigin: string) => {
  if (!urlValue) {
    return;
  }

  const hostname = new URL(urlValue).hostname.toLowerCase();
  if (hostname !== normalizedOrigin) {
    throw new Error('Callback and webhook URLs must match the allowed domain/origin host');
  }
};

export const generateMerchantCredential = (environment: 'SANDBOX' | 'PRODUCTION') => {
  const envLabel = environment === 'PRODUCTION' ? 'live' : 'test';
  const clientId = `wpa_${envLabel}_${randomBytes(12).toString('hex')}`;
  const clientSecret = `wpa_secret_${envLabel}_${randomBytes(24).toString('hex')}`;

  return {
    clientId,
    clientSecret,
    secretHash: createHash('sha256').update(clientSecret).digest('hex'),
    secretPreview: maskSecret(clientSecret),
    encryptedSecret: encryptValue(clientSecret, env.CREDENTIAL_ENCRYPTION_KEY || 'default-secret-key-32-chars-length!!')
  };
};

export const maskSecret = (value: string) => {
  if (value.length <= 10) {
    return '********';
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const serializeMerchantDomain = (domain: MerchantDomain) => ({
  id: domain.id,
  origin: domain.origin,
  callback_url: domain.callbackUrl,
  webhook_url: domain.webhookUrl,
  status: domain.status,
  environment: domain.environment,
  created_at: domain.createdAt,
  updated_at: domain.updatedAt
});

type MerchantApiKeyWithCreator = MerchantApiKey & {
  createdBy: {
    id: string;
    email: string;
  } | null;
};

export const serializeMerchantApiKey = (key: MerchantApiKeyWithCreator) => ({
  id: key.id,
  label: key.label,
  client_id_masked: maskSecret(key.clientId),
  secret_preview: key.secretPreview,
  status: key.status,
  environment: key.environment,
  last_used_at: key.lastUsedAt,
  expires_at: key.expiresAt,
  created_at: key.createdAt,
  updated_at: key.updatedAt,
  rotated_at: key.rotatedAt,
  revoked_at: key.revokedAt,
  created_by: key.createdBy
    ? {
        id: key.createdBy.id,
        email: key.createdBy.email
      }
    : null
});

type MerchantSummary = Merchant & {
  _count: {
    apiKeys: number;
    domains: number;
  };
};

export const serializeMerchantSummary = (merchant: MerchantSummary) => ({
  id: merchant.id,
  name: merchant.name,
  business_name: merchant.businessName,
  contact_email: merchant.contactEmail,
  contact_phone: merchant.contactPhone,
  status: merchant.status,
  environment: merchant.environment,
  notes: merchant.notes,
  active_api_key_count: merchant._count.apiKeys,
  domain_count: merchant._count.domains,
  created_at: merchant.createdAt,
  updated_at: merchant.updatedAt
});

type MerchantDetail = Merchant & {
  apiKeys: MerchantApiKeyWithCreator[];
  domains: MerchantDomain[];
};

export const serializeMerchantDetail = (merchant: MerchantDetail) => ({
  id: merchant.id,
  name: merchant.name,
  business_name: merchant.businessName,
  contact_email: merchant.contactEmail,
  contact_phone: merchant.contactPhone,
  status: merchant.status,
  environment: merchant.environment,
  notes: merchant.notes,
  domains: merchant.domains.map(serializeMerchantDomain),
  api_keys: merchant.apiKeys.map(serializeMerchantApiKey),
  created_at: merchant.createdAt,
  updated_at: merchant.updatedAt
});

export const merchantDetailInclude = {
  domains: {
    orderBy: [{ environment: 'asc' }, { origin: 'asc' }]
  },
  apiKeys: {
    include: {
      createdBy: {
        select: {
          id: true,
          email: true
        }
      }
    },
    orderBy: [{ createdAt: 'desc' }]
  }
} satisfies Prisma.MerchantInclude;
