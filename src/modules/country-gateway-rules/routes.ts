import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { InternationalDisplayPolicy } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';

const idSchema = z.object({ id: z.string().min(1) });

const listQuerySchema = z.object({
  search: z.string().optional(),
  regionCode: z.string().optional(),
  internationalDisplayPolicy: z.nativeEnum(InternationalDisplayPolicy).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  source: z.enum(['SEED', 'ADMIN', 'all']).default('all'),
  defaultCurrency: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const countryCodeRegex = /^[A-Z]{2,3}$/;
const currencyCodeRegex = /^[A-Z]{3}$/;

const createSchema = z.object({
  countryCode: z.string().regex(countryCodeRegex, 'Must be 2–3 uppercase letters (ISO 3166-1)'),
  countryName: z.string().min(1).max(100),
  regionCode: z.string().max(50).optional(),
  regionName: z.string().max(100).optional(),
  defaultCurrency: z.string().regex(currencyCodeRegex, 'Must be exactly 3 uppercase letters (ISO 4217)'),
  localGatewaysEnabled: z.boolean().default(true),
  internationalGatewaysEnabled: z.boolean().default(true),
  internationalDisplayPolicy: z.nativeEnum(InternationalDisplayPolicy),
  fallbackToInternationalWhenNoLocal: z.boolean().default(true),
  isActive: z.boolean().default(true),
  notes: z.string().max(500).optional()
});

const updateSchema = z.object({
  countryName: z.string().min(1).max(100).optional(),
  regionCode: z.string().max(50).nullable().optional(),
  regionName: z.string().max(100).nullable().optional(),
  defaultCurrency: z.string().regex(currencyCodeRegex, 'Must be exactly 3 uppercase letters (ISO 4217)').optional(),
  localGatewaysEnabled: z.boolean().optional(),
  internationalGatewaysEnabled: z.boolean().optional(),
  internationalDisplayPolicy: z.nativeEnum(InternationalDisplayPolicy).optional(),
  fallbackToInternationalWhenNoLocal: z.boolean().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional()
});

export const countryGatewayRuleRoutes: FastifyPluginAsync = async (app) => {
  // ── List ────────────────────────────────────────────────────────────────────

  app.get(
    '/admin/country-gateway-rules',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateQuery(listQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof listQuerySchema>;

      const where: Record<string, unknown> = {};
      if (q.status !== 'all') where.isActive = q.status === 'active';
      if (q.source !== 'all') where.source = q.source;
      if (q.regionCode) where.regionCode = q.regionCode.toUpperCase();
      if (q.internationalDisplayPolicy) where.internationalDisplayPolicy = q.internationalDisplayPolicy;
      if (q.defaultCurrency) where.defaultCurrency = q.defaultCurrency.toUpperCase();

      if (q.search) {
        const t = q.search.trim();
        where.OR = [
          { countryName: { contains: t, mode: 'insensitive' } },
          { countryCode: { contains: t.toUpperCase() } }
        ];
      }

      const [data, total] = await Promise.all([
        prisma.countryGatewayRule.findMany({
          where,
          orderBy: { countryCode: 'asc' },
          skip: (q.page - 1) * q.limit,
          take: q.limit
        }),
        prisma.countryGatewayRule.count({ where })
      ]);

      return {
        data,
        pagination: { total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) }
      };
    }
  );

  // ── Get Single ──────────────────────────────────────────────────────────────

  app.get(
    '/admin/country-gateway-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateParams(idSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idSchema>;
      const rule = await prisma.countryGatewayRule.findUnique({ where: { id } });
      if (!rule) throw new ApiError(404, 'NOT_FOUND', 'Country gateway rule not found');
      return rule;
    }
  );

  // ── Create ──────────────────────────────────────────────────────────────────

  app.post(
    '/admin/country-gateway-rules',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateBody(createSchema)
    },
    async (request, reply) => {
      const payload = request.body as z.infer<typeof createSchema>;

      const existing = await prisma.countryGatewayRule.findUnique({
        where: { countryCode: payload.countryCode }
      });
      if (existing) {
        throw new ApiError(409, 'CONFLICT', `A rule for country code ${payload.countryCode} already exists`);
      }

      const rule = await prisma.countryGatewayRule.create({
        data: {
          countryCode: payload.countryCode,
          countryName: payload.countryName,
          regionCode: payload.regionCode ?? null,
          regionName: payload.regionName ?? null,
          defaultCurrency: payload.defaultCurrency,
          localGatewaysEnabled: payload.localGatewaysEnabled,
          internationalGatewaysEnabled: payload.internationalGatewaysEnabled,
          internationalDisplayPolicy: payload.internationalDisplayPolicy,
          fallbackToInternationalWhenNoLocal: payload.fallbackToInternationalWhenNoLocal,
          isActive: payload.isActive,
          notes: payload.notes ?? null,
          source: 'ADMIN',
          isSystemSeeded: false
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'COUNTRY_GATEWAY_RULE_CREATED',
          entityType: 'CountryGatewayRule',
          entityId: rule.id,
          ipAddress: request.ip,
          metadata: { countryCode: payload.countryCode }
        }
      });

      return reply.status(201).send(rule);
    }
  );

  // ── Update ──────────────────────────────────────────────────────────────────

  app.put(
    '/admin/country-gateway-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(idSchema), validateBody(updateSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idSchema>;
      const payload = request.body as z.infer<typeof updateSchema>;

      const rule = await prisma.countryGatewayRule.update({
        where: { id },
        data: {
          ...(payload.countryName !== undefined && { countryName: payload.countryName }),
          ...(payload.regionCode !== undefined && { regionCode: payload.regionCode }),
          ...(payload.regionName !== undefined && { regionName: payload.regionName }),
          ...(payload.defaultCurrency !== undefined && { defaultCurrency: payload.defaultCurrency }),
          ...(payload.localGatewaysEnabled !== undefined && { localGatewaysEnabled: payload.localGatewaysEnabled }),
          ...(payload.internationalGatewaysEnabled !== undefined && { internationalGatewaysEnabled: payload.internationalGatewaysEnabled }),
          ...(payload.internationalDisplayPolicy !== undefined && { internationalDisplayPolicy: payload.internationalDisplayPolicy }),
          ...(payload.fallbackToInternationalWhenNoLocal !== undefined && { fallbackToInternationalWhenNoLocal: payload.fallbackToInternationalWhenNoLocal }),
          ...(payload.isActive !== undefined && { isActive: payload.isActive }),
          ...(payload.notes !== undefined && { notes: payload.notes }),
          source: 'ADMIN'
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'COUNTRY_GATEWAY_RULE_UPDATED',
          entityType: 'CountryGatewayRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: payload
        }
      });

      return rule;
    }
  );

  // ── Toggle Active ───────────────────────────────────────────────────────────

  app.patch(
    '/admin/country-gateway-rules/:id/toggle',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(idSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof idSchema>;
      const current = await prisma.countryGatewayRule.findUnique({ where: { id }, select: { isActive: true } });
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Country gateway rule not found');

      const rule = await prisma.countryGatewayRule.update({
        where: { id },
        data: { isActive: !current.isActive }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: rule.isActive ? 'COUNTRY_RULE_ENABLED' : 'COUNTRY_RULE_DISABLED',
          entityType: 'CountryGatewayRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: { isActive: rule.isActive }
        }
      });

      return rule;
    }
  );

  // ── Delete (safe) ───────────────────────────────────────────────────────────

  app.delete(
    '/admin/country-gateway-rules/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(idSchema)
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idSchema>;
      const rule = await prisma.countryGatewayRule.findUnique({ where: { id } });
      if (!rule) throw new ApiError(404, 'NOT_FOUND', 'Country gateway rule not found');

      await prisma.countryGatewayRule.delete({ where: { id } });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'COUNTRY_GATEWAY_RULE_DELETED',
          entityType: 'CountryGatewayRule',
          entityId: id,
          ipAddress: request.ip,
          metadata: { countryCode: rule.countryCode }
        }
      });

      return reply.status(204).send();
    }
  );
};
