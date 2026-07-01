import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { CredentialScope, MerchantEnvironment, PaymentPurpose } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';

const idSchema = z.object({ id: z.string().min(1) });

const listQuerySchema = z.object({
  search: z.string().optional(),
  countryCode: z.string().optional(),
  currencyCode: z.string().optional(),
  purpose: z.string().optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const createSchema = z.object({
  providerId: z.string().min(1),
  credentialProfileId: z.string().nullable().optional(),
  countryCode: z.string().min(2).max(3),
  currencyCode: z.string().min(3).max(3),
  purpose: z.nativeEnum(PaymentPurpose),
  environment: z.nativeEnum(MerchantEnvironment),
  scopeType: z.nativeEnum(CredentialScope).default(CredentialScope.PLATFORM),
  scopeId: z.string().nullable().optional(),
  priority: z.number().int().default(100),
  showAtCheckout: z.boolean().default(true),
  fallbackAllowed: z.boolean().default(true),
  isActive: z.boolean().default(true)
});

const updateSchema = z.object({
  credentialProfileId: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  showAtCheckout: z.boolean().optional(),
  fallbackAllowed: z.boolean().optional(),
  isActive: z.boolean().optional()
});

export const gatewayRoutingRuleRoutes: FastifyPluginAsync = async (app) => {
  // GET List of GatewayRoutingRules
  app.get(
    '/admin/gateway-routing-rules',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateQuery(listQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof listQuerySchema>;
      const where: any = {};

      if (q.countryCode) where.countryCode = q.countryCode.toUpperCase();
      if (q.currencyCode) where.currencyCode = q.currencyCode.toUpperCase();
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
        prisma.gatewayRoutingRule.findMany({
          where,
          include: {
            provider: true,
            credentialProfile: true
          },
          orderBy: [{ countryCode: 'asc' }, { priority: 'asc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit
        }),
        prisma.gatewayRoutingRule.count({ where })
      ]);

      return {
        data,
        pagination: { total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) }
      };
    }
  );

  // POST create a new GatewayRoutingRule
  app.post(
    '/admin/gateway-routing-rules',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateBody(createSchema)
    },
    async (request, reply) => {
      const payload = request.body as z.infer<typeof createSchema>;
      const ucCountry = payload.countryCode.toUpperCase();
      const ucCurrency = payload.currencyCode.toUpperCase();

      // Check unique constraint: countryCode + currencyCode + purpose + providerId + environment + scopeType + scopeId
      const existing = await prisma.gatewayRoutingRule.findFirst({
        where: {
          countryCode: ucCountry,
          currencyCode: ucCurrency,
          purpose: payload.purpose,
          providerId: payload.providerId,
          environment: payload.environment,
          scopeType: payload.scopeType,
          scopeId: payload.scopeId || null
        }
      });

      if (existing) {
        throw new ApiError(
          409,
          'CONFLICT',
          `A routing rule already exists for this country (${ucCountry}), currency (${ucCurrency}), purpose (${payload.purpose}), provider, environment, and scope.`
        );
      }

      const rule = await prisma.gatewayRoutingRule.create({
        data: {
          providerId: payload.providerId,
          credentialProfileId: payload.credentialProfileId || null,
          countryCode: ucCountry,
          currencyCode: ucCurrency,
          purpose: payload.purpose,
          environment: payload.environment,
          scopeType: payload.scopeType,
          scopeId: payload.scopeId || null,
          priority: payload.priority,
          showAtCheckout: payload.showAtCheckout,
          fallbackAllowed: payload.fallbackAllowed,
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
          action: 'GATEWAY_ROUTING_RULE_CREATED',
          entityType: 'GatewayRoutingRule',
          entityId: rule.id,
          ipAddress: request.ip,
          metadata: {
            countryCode: ucCountry,
            currencyCode: ucCurrency,
            purpose: payload.purpose,
            providerId: payload.providerId
          }
        }
      });

      return reply.status(201).send(rule);
    }
  );

  // PUT update a GatewayRoutingRule
  app.put(
    '/admin/gateway-routing-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(idSchema), validateBody(updateSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idSchema>;
      const payload = request.body as z.infer<typeof updateSchema>;

      const rule = await prisma.gatewayRoutingRule.update({
        where: { id },
        data: {
          ...(payload.credentialProfileId !== undefined && { credentialProfileId: payload.credentialProfileId }),
          ...(payload.priority !== undefined && { priority: payload.priority }),
          ...(payload.showAtCheckout !== undefined && { showAtCheckout: payload.showAtCheckout }),
          ...(payload.fallbackAllowed !== undefined && { fallbackAllowed: payload.fallbackAllowed }),
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
          action: 'GATEWAY_ROUTING_RULE_UPDATED',
          entityType: 'GatewayRoutingRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: payload
        }
      });

      return rule;
    }
  );

  // DELETE a GatewayRoutingRule
  app.delete(
    '/admin/gateway-routing-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(idSchema)
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idSchema>;

      await prisma.gatewayRoutingRule.delete({ where: { id } });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'GATEWAY_ROUTING_RULE_DELETED',
          entityType: 'GatewayRoutingRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: {}
        }
      });

      return reply.status(204).send();
    }
  );
};
