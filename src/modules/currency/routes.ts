import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { RateSource, RateUpdateMode, RoundingMode } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';
import { computeConversion } from './conversion.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const rateIdSchema = z.object({ id: z.string().min(1) });

const listRatesQuerySchema = z.object({
  search: z.string().optional(),
  source: z.enum(['MANUAL', 'PROVIDER_API', 'SYSTEM', 'all']).default('all'),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  baseCurrency: z.string().max(3).optional(),
  quoteCurrency: z.string().max(3).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const createRateSchema = z.object({
  baseCurrency:  z.string().min(3).max(3).toUpperCase(),
  quoteCurrency: z.string().min(3).max(3).toUpperCase(),
  rate:          z.number().positive(),
  source:        z.nativeEnum(RateSource).default(RateSource.MANUAL),
  providerName:  z.string().max(100).optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo:   z.string().datetime().optional()
});

const updateRateSchema = z.object({
  rate:          z.number().positive().optional(),
  source:        z.nativeEnum(RateSource).optional(),
  providerName:  z.string().max(100).nullable().optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo:   z.string().datetime().nullable().optional()
});

const updateSettingsSchema = z.object({
  defaultBaseCurrency:   z.string().min(3).max(3).toUpperCase().optional(),
  rateUpdateMode:        z.nativeEnum(RateUpdateMode).optional(),
  rateMarkupPercent:     z.number().min(0).max(100).optional(),
  roundingMode:          z.nativeEnum(RoundingMode).optional(),
  staleRateLimitMinutes: z.number().int().min(1).max(43200).optional(),
  isActive:              z.boolean().optional()
});

const convertQuerySchema = z.object({
  amount: z.coerce.number().positive(),
  from:   z.string().min(3).max(3),
  to:     z.string().min(3).max(3)
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the single settings record, creating defaults if absent. */
async function getOrCreateSettings() {
  const existing = await prisma.currencySetting.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return prisma.currencySetting.create({ data: {} });
}

/** Returns the most recent active rate for a currency pair, respecting effectiveTo. */
async function findActiveRate(from: string, to: string) {
  const now = new Date();
  return prisma.currencyRate.findFirst({
    where: {
      baseCurrency: from,
      quoteCurrency: to,
      isActive: true,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }]
    },
    orderBy: { effectiveFrom: 'desc' }
  });
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const currencyRoutes: FastifyPluginAsync = async (app) => {

  // ── Admin: list rates ───────────────────────────────────────────────────────

  app.get(
    '/admin/currency-rates',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateQuery(listRatesQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof listRatesQuerySchema>;
      const where: Record<string, unknown> = {};

      if (q.status !== 'all') where.isActive = q.status === 'active';
      if (q.source !== 'all') where.source = q.source as RateSource;
      if (q.baseCurrency) where.baseCurrency = q.baseCurrency.toUpperCase();
      if (q.quoteCurrency) where.quoteCurrency = q.quoteCurrency.toUpperCase();
      if (q.search) {
        const term = q.search.trim().toUpperCase();
        where.OR = [
          { baseCurrency: { contains: term } },
          { quoteCurrency: { contains: term } }
        ];
      }

      const total = await prisma.currencyRate.count({ where });
      const pages = Math.ceil(total / q.limit);
      const data = await prisma.currencyRate.findMany({
        where,
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { createdBy: { select: { id: true, email: true } } }
      });

      return { data, pagination: { total, page: q.page, limit: q.limit, pages } };
    }
  );

  // ── Admin: get single rate ──────────────────────────────────────────────────

  app.get(
    '/admin/currency-rates/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateParams(rateIdSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof rateIdSchema>;
      const rate = await prisma.currencyRate.findUnique({
        where: { id },
        include: { createdBy: { select: { id: true, email: true } } }
      });
      if (!rate) throw new ApiError(404, 'NOT_FOUND', 'Currency rate not found');
      return rate;
    }
  );

  // ── Admin: create rate ──────────────────────────────────────────────────────

  app.post(
    '/admin/currency-rates',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateBody(createRateSchema)
    },
    async (request, reply) => {
      const payload = request.body as z.infer<typeof createRateSchema>;
      if (payload.baseCurrency === payload.quoteCurrency) {
        throw new ApiError(400, 'INVALID_PAIR', 'Base and quote currency must differ');
      }

      const now = new Date();
      const rate = await prisma.currencyRate.create({
        data: {
          baseCurrency:  payload.baseCurrency,
          quoteCurrency: payload.quoteCurrency,
          rate:          payload.rate,
          source:        payload.source,
          providerName:  payload.providerName ?? null,
          effectiveFrom: payload.effectiveFrom ? new Date(payload.effectiveFrom) : now,
          effectiveTo:   payload.effectiveTo ? new Date(payload.effectiveTo) : null,
          createdByAdminId: request.adminUser?.id ?? null
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'CURRENCY_RATE_CREATED',
          entityType: 'CurrencyRate',
          entityId: rate.id,
          ipAddress: request.ip,
          metadata: { pair: `${rate.baseCurrency}/${rate.quoteCurrency}`, rate: payload.rate, source: payload.source }
        }
      });

      return reply.status(201).send(rate);
    }
  );

  // ── Admin: update rate ──────────────────────────────────────────────────────

  app.put(
    '/admin/currency-rates/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(rateIdSchema), validateBody(updateRateSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof rateIdSchema>;
      const payload = request.body as z.infer<typeof updateRateSchema>;

      const existing = await prisma.currencyRate.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Currency rate not found');

      const rate = await prisma.currencyRate.update({
        where: { id },
        data: {
          ...(payload.rate !== undefined && { rate: payload.rate }),
          ...(payload.source !== undefined && { source: payload.source }),
          ...(payload.providerName !== undefined && { providerName: payload.providerName }),
          ...(payload.effectiveFrom !== undefined && { effectiveFrom: new Date(payload.effectiveFrom!) }),
          ...(payload.effectiveTo !== undefined && { effectiveTo: payload.effectiveTo ? new Date(payload.effectiveTo) : null })
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'CURRENCY_RATE_UPDATED',
          entityType: 'CurrencyRate',
          entityId: id,
          ipAddress: request.ip,
          metadata: payload
        }
      });

      return rate;
    }
  );

  // ── Admin: toggle rate active ───────────────────────────────────────────────

  app.patch(
    '/admin/currency-rates/:id/toggle',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(rateIdSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof rateIdSchema>;
      const current = await prisma.currencyRate.findUnique({ where: { id }, select: { isActive: true } });
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Currency rate not found');

      const rate = await prisma.currencyRate.update({
        where: { id },
        data: { isActive: !current.isActive }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: rate.isActive ? 'CURRENCY_RATE_ENABLED' : 'CURRENCY_RATE_DISABLED',
          entityType: 'CurrencyRate',
          entityId: id,
          ipAddress: request.ip,
          metadata: { isActive: rate.isActive }
        }
      });

      return rate;
    }
  );

  // ── Admin: get settings ─────────────────────────────────────────────────────

  app.get(
    '/admin/currency-settings',
    { preHandler: [requireAdminAuth, requirePermission('providers:read')] },
    async () => getOrCreateSettings()
  );

  // ── Admin: update settings ──────────────────────────────────────────────────

  app.put(
    '/admin/currency-settings',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateBody(updateSettingsSchema)
    },
    async (request) => {
      const payload = request.body as z.infer<typeof updateSettingsSchema>;
      const settings = await getOrCreateSettings();

      const updated = await prisma.currencySetting.update({
        where: { id: settings.id },
        data: {
          ...(payload.defaultBaseCurrency !== undefined && { defaultBaseCurrency: payload.defaultBaseCurrency }),
          ...(payload.rateUpdateMode !== undefined && { rateUpdateMode: payload.rateUpdateMode }),
          ...(payload.rateMarkupPercent !== undefined && { rateMarkupPercent: payload.rateMarkupPercent }),
          ...(payload.roundingMode !== undefined && { roundingMode: payload.roundingMode }),
          ...(payload.staleRateLimitMinutes !== undefined && { staleRateLimitMinutes: payload.staleRateLimitMinutes }),
          ...(payload.isActive !== undefined && { isActive: payload.isActive })
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'CURRENCY_SETTINGS_UPDATED',
          entityType: 'CurrencySetting',
          entityId: settings.id,
          ipAddress: request.ip,
          metadata: payload
        }
      });

      return updated;
    }
  );

  // ── Public: convert amount ──────────────────────────────────────────────────

  app.get(
    '/api/v1/currency/convert',
    { preValidation: validateQuery(convertQuerySchema) },
    async (request) => {
      const q = request.query as z.infer<typeof convertQuerySchema>;
      const from = q.from.toUpperCase();
      const to   = q.to.toUpperCase();

      if (from === to) {
        return {
          from,
          to,
          originalAmount: q.amount,
          convertedAmount: q.amount,
          rate: '1.00000000',
          markupPercent: '0.00',
          effectiveRate: '1.00000000',
          source: 'SYSTEM',
          rateId: null,
          isStale: false,
          staleWarning: null,
          timestamp: new Date().toISOString()
        };
      }

      const rate = await findActiveRate(from, to);
      if (!rate) {
        throw new ApiError(404, 'RATE_NOT_FOUND', `No active exchange rate found for ${from}/${to}`);
      }

      const settings = await getOrCreateSettings();
      const result = computeConversion(q.amount, rate, settings);

      return result;
    }
  );
};
