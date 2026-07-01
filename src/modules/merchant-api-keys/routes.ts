import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { createAuditLog } from '../../services/audit.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody, validateParams } from '../../utils/validation.js';
import {
  adminRoutePaths,
  generateMerchantCredential,
  merchantApiKeyCreateSchema,
  merchantApiKeyIdSchema,
  merchantApiKeyRotateSchema,
  merchantIdSchema,
  parseOptionalDate,
  serializeMerchantApiKey
} from '../merchants/shared.js';

const adminWriteRateLimit = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
      keyGenerator: (request: { ip: string }) => request.ip
    }
  }
};

const keyInclude = {
  createdBy: {
    select: {
      id: true,
      email: true
    }
  }
} as const;

const loadMerchantOrThrow = async (merchantId: string) => {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      id: true,
      status: true
    }
  });

  if (!merchant) {
    throw new ApiError(404, 'NOT_FOUND', 'Merchant not found');
  }

  return merchant;
};

export const merchantApiKeyRoutes: FastifyPluginAsync = async (app) => {
  for (const path of adminRoutePaths('/admin/merchants/:id/api-keys')) {
    app.get(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:read')],
        preValidation: validateParams(merchantIdSchema)
      },
      async (request) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        await loadMerchantOrThrow(id);

        const keys = await prisma.merchantApiKey.findMany({
          where: { merchantId: id },
          include: keyInclude,
          orderBy: [{ createdAt: 'desc' }]
        });

        return {
          data: keys.map(serializeMerchantApiKey)
        };
      }
    );

    app.post(
      path,
      {
        ...adminWriteRateLimit,
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: [validateParams(merchantIdSchema), validateBody(merchantApiKeyCreateSchema)]
      },
      async (request, reply) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        const payload = request.body as ReturnType<typeof merchantApiKeyCreateSchema.parse>;
        const merchant = await loadMerchantOrThrow(id);

        if (payload.environment === 'PRODUCTION' && merchant.status !== 'ACTIVE') {
          throw new ApiError(409, 'CONFLICT', 'Production API keys can only be created for active merchants');
        }

        const credential = generateMerchantCredential(payload.environment);

        const key = await prisma.merchantApiKey.create({
          data: {
            merchantId: id,
            label: payload.label,
            clientId: credential.clientId,
            secretHash: credential.secretHash,
            secretPreview: credential.secretPreview,
            secretIv: credential.encryptedSecret.iv,
            secretAuthTag: credential.encryptedSecret.authTag,
            secretCiphertext: credential.encryptedSecret.ciphertext,
            status: 'ACTIVE',
            environment: payload.environment,
            expiresAt: parseOptionalDate(payload.expires_at),
            createdById: request.adminUser?.id ?? null
          },
          include: keyInclude
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_API_KEY_CREATED',
          entityType: 'MerchantApiKey',
          entityId: key.id,
          ipAddress: request.ip,
          metadata: {
            merchantId: id,
            label: key.label,
            environment: key.environment
          }
        });

        return reply.status(201).send({
          key: serializeMerchantApiKey(key),
          credentials: {
            client_id: credential.clientId,
            client_secret: credential.clientSecret
          }
        });
      }
    );
  }

  for (const path of adminRoutePaths('/admin/merchant-api-keys/:id/rotate')) {
    app.post(
      path,
      {
        ...adminWriteRateLimit,
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: [validateParams(merchantApiKeyIdSchema), validateBody(merchantApiKeyRotateSchema)]
      },
      async (request, reply) => {
        const { id } = request.params as ReturnType<typeof merchantApiKeyIdSchema.parse>;
        const payload = request.body as ReturnType<typeof merchantApiKeyRotateSchema.parse>;

        const existing = await prisma.merchantApiKey.findUnique({
          where: { id },
          include: {
            merchant: {
              select: {
                id: true,
                status: true
              }
            }
          }
        });

        if (!existing) {
          throw new ApiError(404, 'NOT_FOUND', 'API key not found');
        }

        if (existing.status === 'REVOKED') {
          throw new ApiError(409, 'CONFLICT', 'Cannot rotate an already revoked API key');
        }

        if (existing.environment === 'PRODUCTION' && existing.merchant.status !== 'ACTIVE') {
          throw new ApiError(409, 'CONFLICT', 'Production API keys can only be rotated for active merchants');
        }

        const credential = generateMerchantCredential(existing.environment);
        const now = new Date();

        const newKey = await prisma.$transaction(async (tx) => {
          await tx.merchantApiKey.update({
            where: { id: existing.id },
            data: {
              status: 'REVOKED',
              revokedAt: now,
              rotatedAt: now
            }
          });

          return tx.merchantApiKey.create({
            data: {
              merchantId: existing.merchantId,
              label: payload.label ?? existing.label,
              clientId: credential.clientId,
              secretHash: credential.secretHash,
              secretPreview: credential.secretPreview,
              secretIv: credential.encryptedSecret.iv,
              secretAuthTag: credential.encryptedSecret.authTag,
              secretCiphertext: credential.encryptedSecret.ciphertext,
              status: 'ACTIVE',
              environment: existing.environment,
              expiresAt: parseOptionalDate(payload.expires_at) ?? existing.expiresAt,
              createdById: request.adminUser?.id ?? null
            },
            include: keyInclude
          });
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_API_KEY_ROTATED',
          entityType: 'MerchantApiKey',
          entityId: newKey.id,
          ipAddress: request.ip,
          metadata: {
            merchantId: existing.merchantId,
            oldKeyId: existing.id,
            newKeyId: newKey.id
          }
        });

        return reply.status(201).send({
          key: serializeMerchantApiKey(newKey),
          credentials: {
            client_id: credential.clientId,
            client_secret: credential.clientSecret
          }
        });
      }
    );
  }

  for (const path of adminRoutePaths('/admin/merchant-api-keys/:id/revoke')) {
    app.post(
      path,
      {
        ...adminWriteRateLimit,
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: validateParams(merchantApiKeyIdSchema)
      },
      async (request) => {
        const { id } = request.params as ReturnType<typeof merchantApiKeyIdSchema.parse>;
        const existing = await prisma.merchantApiKey.findUnique({
          where: { id }
        });

        if (!existing) {
          throw new ApiError(404, 'NOT_FOUND', 'API key not found');
        }

        if (existing.status === 'REVOKED') {
          throw new ApiError(409, 'CONFLICT', 'API key is already revoked');
        }

        const key = await prisma.merchantApiKey.update({
          where: { id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date()
          },
          include: keyInclude
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_API_KEY_REVOKED',
          entityType: 'MerchantApiKey',
          entityId: key.id,
          ipAddress: request.ip,
          metadata: {
            merchantId: key.merchantId,
            label: key.label
          }
        });

        return {
          key: serializeMerchantApiKey(key)
        };
      }
    );
  }
};
