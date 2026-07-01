import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { createAuditLog } from '../../services/audit.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import {
  adminRoutePaths,
  merchantCreateSchema,
  merchantDetailInclude,
  merchantIdSchema,
  merchantListQuerySchema,
  merchantStatusUpdateSchema,
  merchantUpdateSchema,
  serializeMerchantDetail,
  serializeMerchantSummary
} from './shared.js';

const notDeletedKeyFilter = {
  status: 'ACTIVE' as const
};

const notDeletedDomainFilter = {
  status: 'ACTIVE' as const
};

export const merchantRoutes: FastifyPluginAsync = async (app) => {
  for (const path of adminRoutePaths('/admin/merchants')) {
    app.get(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:read')],
        preValidation: validateQuery(merchantListQuerySchema)
      },
      async (request) => {
        const { page, limit, search, status, environment } = request.query as ReturnType<typeof merchantListQuerySchema.parse>;

        const where = {
          ...(status ? { status } : {}),
          ...(environment ? { environment } : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' as const } },
                  { businessName: { contains: search, mode: 'insensitive' as const } },
                  { contactEmail: { contains: search, mode: 'insensitive' as const } }
                ]
              }
            : {})
        };

        const [data, total] = await Promise.all([
          prisma.merchant.findMany({
            where,
            skip: (page - 1) * limit,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
              _count: {
                select: {
                  apiKeys: { where: notDeletedKeyFilter },
                  domains: { where: notDeletedDomainFilter }
                }
              }
            }
          }),
          prisma.merchant.count({ where })
        ]);

        return {
          data: data.map(serializeMerchantSummary),
          total,
          page,
          limit
        };
      }
    );

    app.post(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: validateBody(merchantCreateSchema)
      },
      async (request, reply) => {
        const payload = request.body as ReturnType<typeof merchantCreateSchema.parse>;

        const existing = await prisma.merchant.findUnique({
          where: { contactEmail: payload.contact_email },
          select: { id: true }
        });

        if (existing) {
          throw new ApiError(409, 'CONFLICT', 'A merchant with this contact email already exists');
        }

        const merchant = await prisma.merchant.create({
          data: {
            name: payload.name,
            businessName: payload.business_name,
            contactEmail: payload.contact_email,
            contactPhone: payload.contact_phone,
            status: payload.status,
            environment: payload.environment,
            notes: payload.notes,
            callbackUrl: null
          },
          include: merchantDetailInclude
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_CREATED',
          entityType: 'Merchant',
          entityId: merchant.id,
          ipAddress: request.ip,
          metadata: {
            name: merchant.name,
            businessName: merchant.businessName,
            environment: merchant.environment,
            status: merchant.status
          }
        });

        return reply.status(201).send(serializeMerchantDetail(merchant));
      }
    );
  }

  for (const path of adminRoutePaths('/admin/merchants/:id')) {
    app.get(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:read')],
        preValidation: validateParams(merchantIdSchema)
      },
      async (request, reply) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        const merchant = await prisma.merchant.findUnique({
          where: { id },
          include: merchantDetailInclude
        });

        if (!merchant) {
          return reply.notFound('Merchant not found');
        }

        return serializeMerchantDetail(merchant);
      }
    );

    app.patch(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: [validateParams(merchantIdSchema), validateBody(merchantUpdateSchema)]
      },
      async (request) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        const payload = request.body as ReturnType<typeof merchantUpdateSchema.parse>;

        if (payload.contact_email) {
          const conflict = await prisma.merchant.findFirst({
            where: {
              contactEmail: payload.contact_email,
              id: {
                not: id
              }
            },
            select: { id: true }
          });

          if (conflict) {
            throw new ApiError(409, 'CONFLICT', 'A merchant with this contact email already exists');
          }
        }

        const merchant = await prisma.merchant.update({
          where: { id },
          data: {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.business_name !== undefined ? { businessName: payload.business_name } : {}),
            ...(payload.contact_email !== undefined ? { contactEmail: payload.contact_email } : {}),
            ...(payload.contact_phone !== undefined ? { contactPhone: payload.contact_phone } : {}),
            ...(payload.status !== undefined ? { status: payload.status } : {}),
            ...(payload.environment !== undefined ? { environment: payload.environment } : {}),
            ...(payload.notes !== undefined ? { notes: payload.notes } : {})
          },
          include: merchantDetailInclude
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_UPDATED',
          entityType: 'Merchant',
          entityId: merchant.id,
          ipAddress: request.ip,
          metadata: payload
        });

        return serializeMerchantDetail(merchant);
      }
    );
  }

  for (const path of adminRoutePaths('/admin/merchants/:id/status')) {
    app.patch(
      path,
      {
        preHandler: [requireAdminAuth, requirePermission('merchants:write')],
        preValidation: [validateParams(merchantIdSchema), validateBody(merchantStatusUpdateSchema)]
      },
      async (request) => {
        const { id } = request.params as ReturnType<typeof merchantIdSchema.parse>;
        const { status } = request.body as ReturnType<typeof merchantStatusUpdateSchema.parse>;

        const merchant = await prisma.merchant.update({
          where: { id },
          data: { status },
          include: merchantDetailInclude
        });

        await createAuditLog({
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'MERCHANT_STATUS_CHANGED',
          entityType: 'Merchant',
          entityId: merchant.id,
          ipAddress: request.ip,
          metadata: {
            status
          }
        });

        return serializeMerchantDetail(merchant);
      }
    );
  }
};
