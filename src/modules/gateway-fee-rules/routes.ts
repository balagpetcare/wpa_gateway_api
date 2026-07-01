import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { FeeBearer, MerchantEnvironment, PaymentPurpose } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';

const idSchema = z.object({ id: z.string().min(1) });

const listQuerySchema = z.object({
  search: z.string().optional(),
  providerId: z.string().optional(),
  purpose: z.string().optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const createSchema = z.object({
  providerId: z.string().min(1),
  credentialProfileId: z.string().nullable().optional(),
  countryCode: z.string().max(3).nullable().optional(),
  currencyCode: z.string().max(3).nullable().optional(),
  purpose: z.nativeEnum(PaymentPurpose),
  environment: z.nativeEnum(MerchantEnvironment),
  percentageFee: z.number().min(0).max(100),
  fixedFee: z.number().min(0),
  minFee: z.number().min(0).nullable().optional(),
  maxFee: z.number().min(0).nullable().optional(),
  feeBearer: z.nativeEnum(FeeBearer).default(FeeBearer.MERCHANT),
  isActive: z.boolean().default(true)
});

const updateSchema = z.object({
  credentialProfileId: z.string().nullable().optional(),
  percentageFee: z.number().min(0).max(100).optional(),
  fixedFee: z.number().min(0).optional(),
  minFee: z.number().min(0).nullable().optional(),
  maxFee: z.number().min(0).nullable().optional(),
  feeBearer: z.nativeEnum(FeeBearer).optional(),
  isActive: z.boolean().optional()
});

export const gatewayFeeRuleRoutes: FastifyPluginAsync = async (app) => {
  // GET list of GatewayFeeRules
  app.get(
    '/admin/gateway-fee-rules',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateQuery(listQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof listQuerySchema>;
      const where: any = {};

      if (q.providerId) where.providerId = q.providerId;
      if (q.purpose) where.purpose = q.purpose as any;
      if (q.environment !== 'all') where.environment = q.environment;

      if (q.search) {
        const t = q.search.trim();
        where.OR = [
          { countryCode: { contains: t.toUpperCase() } },
          { currencyCode: { contains: t.toUpperCase() } },
          { provider: { displayName: { contains: t, mode: 'insensitive' } } }
        ];
      }

      const [data, total] = await Promise.all([
        prisma.gatewayFeeRule.findMany({
          where,
          include: {
            provider: true,
            credentialProfile: true
          },
          orderBy: [{ providerId: 'asc' }, { createdAt: 'desc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit
        }),
        prisma.gatewayFeeRule.count({ where })
      ]);

      return {
        data,
        pagination: { total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) }
      };
    }
  );

  // POST create GatewayFeeRule
  app.post(
    '/admin/gateway-fee-rules',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateBody(createSchema)
    },
    async (request, reply) => {
      const payload = request.body as z.infer<typeof createSchema>;

      const rule = await prisma.gatewayFeeRule.create({
        data: {
          providerId: payload.providerId,
          credentialProfileId: payload.credentialProfileId || null,
          countryCode: payload.countryCode?.toUpperCase() || null,
          currencyCode: payload.currencyCode?.toUpperCase() || null,
          purpose: payload.purpose,
          environment: payload.environment,
          percentageFee: payload.percentageFee,
          fixedFee: payload.fixedFee,
          minFee: payload.minFee ?? null,
          maxFee: payload.maxFee ?? null,
          feeBearer: payload.feeBearer,
          isActive: payload.isActive
        },
        include: {
          provider: true,
          credentialProfile: true
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'GATEWAY_FEE_RULE_CREATED',
          entityType: 'GatewayFeeRule',
          entityId: rule.id,
          ipAddress: request.ip,
          metadata: {
            providerId: payload.providerId,
            purpose: payload.purpose
          }
        }
      });

      return reply.status(201).send(rule);
    }
  );

  // PUT update GatewayFeeRule
  app.put(
    '/admin/gateway-fee-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(idSchema), validateBody(updateSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idSchema>;
      const payload = request.body as z.infer<typeof updateSchema>;

      const rule = await prisma.gatewayFeeRule.update({
        where: { id },
        data: {
          ...(payload.credentialProfileId !== undefined && { credentialProfileId: payload.credentialProfileId }),
          ...(payload.percentageFee !== undefined && { percentageFee: payload.percentageFee }),
          ...(payload.fixedFee !== undefined && { fixedFee: payload.fixedFee }),
          ...(payload.minFee !== undefined && { minFee: payload.minFee }),
          ...(payload.maxFee !== undefined && { maxFee: payload.maxFee }),
          ...(payload.feeBearer !== undefined && { feeBearer: payload.feeBearer }),
          ...(payload.isActive !== undefined && { isActive: payload.isActive })
        },
        include: {
          provider: true,
          credentialProfile: true
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'GATEWAY_FEE_RULE_UPDATED',
          entityType: 'GatewayFeeRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: payload
        }
      });

      return rule;
    }
  );

  // DELETE deactivates/deletes a GatewayFeeRule
  app.delete(
    '/admin/gateway-fee-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(idSchema)
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idSchema>;

      await prisma.gatewayFeeRule.delete({ where: { id } });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'GATEWAY_FEE_RULE_DELETED',
          entityType: 'GatewayFeeRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: {}
        }
      });

      return reply.status(204).send();
    }
  );
};
