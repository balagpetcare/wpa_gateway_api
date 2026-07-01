import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { createAuditLog } from '../../services/audit.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody, validateParams } from '../../utils/validation.js';
import {
  adminRoutePaths,
  assertUrlMatchesOrigin,
  merchantDomainCreateSchema,
  merchantDomainIdSchema,
  merchantDomainUpdateSchema,
  merchantIdSchema,
  normalizeOrigin,
  serializeMerchantDomain
} from '../merchants/shared.js';

const ensureMerchantExists = async (merchantId: string) => {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true }
  });

  if (!merchant) {
    throw new ApiError(404, 'NOT_FOUND', 'Merchant not found');
  }
};

const ensureDomainUnique = async (input: {
  merchantId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  normalizedOrigin: string;
  excludeId?: string;
}) => {
  const existing = await prisma.merchantDomain.findFirst({
    where: {
      merchantId: input.merchantId,
      environment: input.environment,
      normalizedOrigin: input.normalizedOrigin,
      ...(input.excludeId
        ? {
            id: {
              not: input.excludeId
            }
          }
        : {})
    },
    select: { id: true }
  });

  if (existing) {
    throw new ApiError(409, 'CONFLICT', 'This domain/origin already exists for the merchant and environment');
  }
};

export const merchantDomainRoutes: FastifyPluginAsync = async (app) => {
  for (const path of adminRoutePaths('/admin/merchants/:id/domains')) {
    app.get(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:read')],
        preValidation: validateParams(merchantIdSchema)
      },
      async (request) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        await ensureMerchantExists(id);

        const domains = await prisma.merchantDomain.findMany({
          where: { merchantId: id },
          orderBy: [{ environment: 'asc' }, { origin: 'asc' }]
        });

        return {
          data: domains.map(serializeMerchantDomain)
        };
      }
    );

    app.post(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: [validateParams(merchantIdSchema), validateBody(merchantDomainCreateSchema)]
      },
      async (request, reply) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        const payload = request.body as ReturnType<typeof merchantDomainCreateSchema.parse>;
        await ensureMerchantExists(id);

        let normalized;
        try {
          normalized = normalizeOrigin(payload.origin);
          assertUrlMatchesOrigin(payload.callback_url, normalized.normalizedOrigin);
          assertUrlMatchesOrigin(payload.webhook_url, normalized.normalizedOrigin);
        } catch (error) {
          throw new ApiError(400, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Invalid origin');
        }

        await ensureDomainUnique({
          merchantId: id,
          environment: payload.environment,
          normalizedOrigin: normalized.normalizedOrigin
        });

        const domain = await prisma.merchantDomain.create({
          data: {
            merchantId: id,
            origin: normalized.origin,
            normalizedOrigin: normalized.normalizedOrigin,
            callbackUrl: payload.callback_url,
            webhookUrl: payload.webhook_url,
            status: payload.status,
            environment: payload.environment
          }
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_DOMAIN_CREATED',
          entityType: 'MerchantDomain',
          entityId: domain.id,
          ipAddress: request.ip,
          metadata: {
            merchantId: id,
            origin: domain.origin,
            environment: domain.environment
          }
        });

        return reply.status(201).send(serializeMerchantDomain(domain));
      }
    );
  }

  for (const path of adminRoutePaths('/admin/merchant-domains/:id')) {
    app.patch(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: [validateParams(merchantDomainIdSchema), validateBody(merchantDomainUpdateSchema)]
      },
      async (request) => {
        const { id } = request.params as ReturnType<typeof merchantDomainIdSchema.parse>;
        const payload = request.body as ReturnType<typeof merchantDomainUpdateSchema.parse>;

        const existing = await prisma.merchantDomain.findUnique({
          where: { id }
        });

        if (!existing) {
          throw new ApiError(404, 'NOT_FOUND', 'Merchant domain not found');
        }

        const nextEnvironment = payload.environment ?? existing.environment;
        let normalized = {
          origin: existing.origin,
          normalizedOrigin: existing.normalizedOrigin
        };

        try {
          if (payload.origin) {
            normalized = normalizeOrigin(payload.origin);
          }
          assertUrlMatchesOrigin(payload.callback_url ?? existing.callbackUrl ?? undefined, normalized.normalizedOrigin);
          assertUrlMatchesOrigin(payload.webhook_url ?? existing.webhookUrl ?? undefined, normalized.normalizedOrigin);
        } catch (error) {
          throw new ApiError(400, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Invalid origin');
        }

        await ensureDomainUnique({
          merchantId: existing.merchantId,
          environment: nextEnvironment,
          normalizedOrigin: normalized.normalizedOrigin,
          excludeId: existing.id
        });

        const domain = await prisma.merchantDomain.update({
          where: { id },
          data: {
            ...(payload.origin !== undefined
              ? {
                  origin: normalized.origin,
                  normalizedOrigin: normalized.normalizedOrigin
                }
              : {}),
            ...(payload.callback_url !== undefined ? { callbackUrl: payload.callback_url } : {}),
            ...(payload.webhook_url !== undefined ? { webhookUrl: payload.webhook_url } : {}),
            ...(payload.status !== undefined ? { status: payload.status } : {}),
            ...(payload.environment !== undefined ? { environment: payload.environment } : {})
          }
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_DOMAIN_UPDATED',
          entityType: 'MerchantDomain',
          entityId: domain.id,
          ipAddress: request.ip,
          metadata: payload
        });

        return serializeMerchantDomain(domain);
      }
    );

    app.delete(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: validateParams(merchantDomainIdSchema)
      },
      async (request, reply) => {
        const { id } = request.params as ReturnType<typeof merchantDomainIdSchema.parse>;
        const domain = await prisma.merchantDomain.findUnique({
          where: { id }
        });

        if (!domain) {
          throw new ApiError(404, 'NOT_FOUND', 'Merchant domain not found');
        }

        await prisma.merchantDomain.delete({
          where: { id }
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_DOMAIN_DELETED',
          entityType: 'MerchantDomain',
          entityId: id,
          ipAddress: request.ip,
          metadata: {
            merchantId: domain.merchantId,
            origin: domain.origin,
            environment: domain.environment
          }
        });

        return reply.status(204).send();
      }
    );
  }
};
