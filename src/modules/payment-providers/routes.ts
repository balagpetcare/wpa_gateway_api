import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { CoverageType, MerchantEnvironment, ProviderName } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { attachCheckoutProviderReadiness, attachProviderReadiness } from '../../providers/readiness.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';
import { resolveCheckoutProviders } from './checkout-routing.js';

const providerIdSchema = z.object({
  providerId: z.string().min(1)
});

const adminListQuerySchema = z.object({
  search: z.string().optional(),
  countryCode: z.string().optional(),
  regionCode: z.string().optional(),
  currency: z.string().optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  environment: z.enum(['SANDBOX', 'PRODUCTION', 'all']).default('all'),
  coverageType: z.enum(['LOCAL', 'REGIONAL', 'GLOBAL', 'all']).default('all'),
  developmentOnly: z.enum(['true', 'false', 'all']).default('all'),
  adapterType: z.string().optional(),
  sortBy: z.enum(['priority', 'displayName', 'country', 'createdAt', 'updatedAt']).default('priority'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

// Accepts https?:// URLs or /media/ relative paths
const mediaUrl = z
  .string()
  .refine((v) => /^https?:\/\//.test(v) || /^\//.test(v), {
    message: 'Must be a valid URL (https://…) or a media path starting with /'
  });

const createProviderSchema = z.object({
  name: z.nativeEnum(ProviderName),
  displayName: z.string().min(1).max(100),
  checkoutDisplayName: z.string().max(100).optional(),
  checkoutDescription: z.string().max(500).optional(),
  isActive: z.boolean().default(false),
  isDevelopmentOnly: z.boolean().default(false),
  environment: z.nativeEnum(MerchantEnvironment).default(MerchantEnvironment.SANDBOX),
  adapterType: z.string().max(50).optional(),
  coverageType: z.nativeEnum(CoverageType).default(CoverageType.LOCAL),
  regionCode: z.string().max(10).optional(),
  logoUrl: mediaUrl.optional(),
  iconUrl: mediaUrl.optional(),
  brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color e.g. #635BFF').optional(),
  supportedCurrencies: z.array(z.string().min(1)).min(1),
  supportedCountries: z.array(z.string().min(1)).min(1),
  priority: z.number().int().min(0).max(9999).default(100)
});

const updateProviderSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  checkoutDisplayName: z.string().max(100).nullable().optional(),
  checkoutDescription: z.string().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  isDevelopmentOnly: z.boolean().optional(),
  adapterType: z.string().max(50).nullable().optional(),
  coverageType: z.nativeEnum(CoverageType).optional(),
  regionCode: z.string().max(10).nullable().optional(),
  logoUrl: mediaUrl.nullable().optional(),
  iconUrl: mediaUrl.nullable().optional(),
  brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color e.g. #635BFF').nullable().optional(),
  supportedCurrencies: z.array(z.string().min(1)).min(1).optional(),
  supportedCountries: z.array(z.string().min(1)).min(1).optional(),
  priority: z.number().int().min(0).max(9999).optional()
});

const availableProvidersQuerySchema = z.object({
  countryCode: z.string().min(2).max(3),
  currency: z.string().min(3).max(3),
  regionCode: z.string().max(10).optional(),
  includeDevelopment: z.enum(['true', 'false']).default('false')
});

type SortableField = 'priority' | 'displayName' | 'createdAt' | 'updatedAt';

const DB_SORT_MAP: Record<string, SortableField> = {
  priority: 'priority',
  displayName: 'displayName',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

export const paymentProviderRoutes: FastifyPluginAsync = async (app) => {
  // ── Admin List (filtered/sorted/paginated) ──────────────────────────────────

  app.get(
    '/admin/providers',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateQuery(adminListQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof adminListQuerySchema>;

      // Build scalar where clauses
      const where: Record<string, unknown> = {};

      if (q.status !== 'all') where.isActive = q.status === 'active';
      if (q.environment !== 'all') where.environment = q.environment as MerchantEnvironment;
      if (q.coverageType !== 'all') where.coverageType = q.coverageType as CoverageType;
      if (q.developmentOnly !== 'all') where.isDevelopmentOnly = q.developmentOnly === 'true';
      if (q.regionCode) where.regionCode = q.regionCode.toUpperCase();
      if (q.adapterType) where.adapterType = q.adapterType.toLowerCase();

      if (q.search) {
        const term = q.search.trim();
        where.OR = [
          { displayName: { contains: term, mode: 'insensitive' } },
          { name: { equals: term.toUpperCase() } },
          { adapterType: { contains: term, mode: 'insensitive' } },
          { id: { startsWith: term } }
        ];
      }

      // Determine DB-level sort (country sort is done in-app after JSON filter)
      const dbSortField = DB_SORT_MAP[q.sortBy] ?? 'priority';
      const dbOrderBy = [{ [dbSortField]: q.sortOrder }];

      // Fetch all matching scalar rows (JSON array filtering done in-app)
      const rows = await prisma.paymentProvider.findMany({
        where,
        orderBy: dbOrderBy
      });

      // In-app JSON array filters
      const countryUpper = q.countryCode?.toUpperCase();
      const currencyUpper = q.currency?.toUpperCase();

      let filtered = rows.filter((p) => {
        const countries = Array.isArray(p.supportedCountries) ? (p.supportedCountries as string[]) : [];
        const currencies = Array.isArray(p.supportedCurrencies) ? (p.supportedCurrencies as string[]) : [];
        if (countryUpper && !countries.includes(countryUpper)) return false;
        if (currencyUpper && !currencies.includes(currencyUpper)) return false;
        return true;
      });

      // In-app sort for "country A-Z" (by first supported country)
      if (q.sortBy === 'country') {
        filtered.sort((a, b) => {
          const aCountry = (Array.isArray(a.supportedCountries) ? (a.supportedCountries as string[])[0] : '') ?? '';
          const bCountry = (Array.isArray(b.supportedCountries) ? (b.supportedCountries as string[])[0] : '') ?? '';
          return q.sortOrder === 'asc'
            ? aCountry.localeCompare(bCountry)
            : bCountry.localeCompare(aCountry);
        });
      }

      const total = filtered.length;
      const pages = Math.ceil(total / q.limit);
      const start = (q.page - 1) * q.limit;
      const data = filtered.slice(start, start + q.limit).map((provider) => attachProviderReadiness(provider));

      return {
        data,
        pagination: { total, page: q.page, limit: q.limit, pages }
      };
    }
  );

  // ── Admin Get Single ────────────────────────────────────────────────────────

  app.get(
    '/admin/providers/:providerId',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateParams(providerIdSchema)
    },
    async (request) => {
      const { providerId } = request.params as z.infer<typeof providerIdSchema>;
      const provider = await prisma.paymentProvider.findUnique({
        where: { id: providerId },
        include: {
          credentials: {
            where: { isActive: true },
            select: { id: true, keyLabel: true, scope: true, merchantId: true, createdAt: true }
          }
        }
      });

      return {
        data: provider ? attachProviderReadiness(provider) : null
      };
    }
  );

  // ── Admin Create ────────────────────────────────────────────────────────────

  app.post(
    '/admin/providers',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateBody(createProviderSchema)
    },
    async (request, reply) => {
      const payload = request.body as z.infer<typeof createProviderSchema>;

      const existing = await prisma.paymentProvider.findUnique({
        where: { name_environment: { name: payload.name, environment: payload.environment } }
      });
      if (existing) {
        throw new ApiError(
          409,
          'CONFLICT',
          `A provider with code ${payload.name} and environment ${payload.environment} already exists`
        );
      }

      const provider = await prisma.paymentProvider.create({
        data: {
          name: payload.name,
          displayName: payload.displayName,
          checkoutDisplayName: payload.checkoutDisplayName ?? null,
          checkoutDescription: payload.checkoutDescription ?? null,
          isActive: payload.isActive,
          isDevelopmentOnly: payload.isDevelopmentOnly,
          environment: payload.environment,
          adapterType: payload.adapterType ?? null,
          coverageType: payload.coverageType,
          regionCode: payload.regionCode ?? null,
          logoUrl: payload.logoUrl ?? null,
          iconUrl: payload.iconUrl ?? null,
          brandColor: payload.brandColor ?? null,
          supportedCurrencies: payload.supportedCurrencies,
          supportedCountries: payload.supportedCountries,
          priority: payload.priority
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'PAYMENT_PROVIDER_CREATED',
          entityType: 'PaymentProvider',
          entityId: provider.id,
          ipAddress: request.ip,
          metadata: { name: payload.name, environment: payload.environment }
        }
      });

      return reply.status(201).send({
        data: provider
      });
    }
  );

  // ── Admin Update ────────────────────────────────────────────────────────────

  app.put(
    '/admin/providers/:providerId',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(providerIdSchema), validateBody(updateProviderSchema)]
    },
    async (request) => {
      const { providerId } = request.params as z.infer<typeof providerIdSchema>;
      const payload = request.body as z.infer<typeof updateProviderSchema>;

      const provider = await prisma.paymentProvider.update({
        where: { id: providerId },
        data: {
          ...(payload.displayName !== undefined && { displayName: payload.displayName }),
          ...(payload.checkoutDisplayName !== undefined && { checkoutDisplayName: payload.checkoutDisplayName }),
          ...(payload.checkoutDescription !== undefined && { checkoutDescription: payload.checkoutDescription }),
          ...(payload.isActive !== undefined && { isActive: payload.isActive }),
          ...(payload.isDevelopmentOnly !== undefined && { isDevelopmentOnly: payload.isDevelopmentOnly }),
          ...(payload.adapterType !== undefined && { adapterType: payload.adapterType }),
          ...(payload.coverageType !== undefined && { coverageType: payload.coverageType }),
          ...(payload.regionCode !== undefined && { regionCode: payload.regionCode }),
          ...(payload.logoUrl !== undefined && { logoUrl: payload.logoUrl }),
          ...(payload.iconUrl !== undefined && { iconUrl: payload.iconUrl }),
          ...(payload.brandColor !== undefined && { brandColor: payload.brandColor }),
          ...(payload.supportedCurrencies !== undefined && { supportedCurrencies: payload.supportedCurrencies }),
          ...(payload.supportedCountries !== undefined && { supportedCountries: payload.supportedCountries }),
          ...(payload.priority !== undefined && { priority: payload.priority })
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'PAYMENT_PROVIDER_UPDATED',
          entityType: 'PaymentProvider',
          entityId: providerId,
          ipAddress: request.ip,
          metadata: payload
        }
      });

      return {
        data: provider
      };
    }
  );

  // ── Admin Toggle Active ─────────────────────────────────────────────────────

  app.patch(
    '/admin/providers/:providerId/toggle',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(providerIdSchema)
    },
    async (request) => {
      const { providerId } = request.params as z.infer<typeof providerIdSchema>;
      const current = await prisma.paymentProvider.findUnique({ where: { id: providerId }, select: { isActive: true } });
      if (!current) throw new ApiError(404, 'NOT_FOUND', 'Provider not found');

      const provider = await prisma.paymentProvider.update({
        where: { id: providerId },
        data: { isActive: !current.isActive }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: provider.isActive ? 'PAYMENT_PROVIDER_ENABLED' : 'PAYMENT_PROVIDER_DISABLED',
          entityType: 'PaymentProvider',
          entityId: providerId,
          ipAddress: request.ip,
          metadata: { isActive: provider.isActive }
        }
      });

      return {
        data: provider
      };
    }
  );

  // ── Public checkout available providers ─────────────────────────────────────

  app.get(
    '/api/v1/payments/providers/available',
    { preValidation: validateQuery(availableProvidersQuerySchema) },
    async (request) => {
      const q = request.query as z.infer<typeof availableProvidersQuerySchema>;
      const countryCode = q.countryCode.toUpperCase();
      const currency = q.currency.toUpperCase();
      const regionCode = q.regionCode?.toUpperCase() ?? null;
      const includeDevelopment = q.includeDevelopment === 'true';

      // Fetch active rule for this country (if any)
      const rule = await prisma.countryGatewayRule.findUnique({
        where: { countryCode }
      });

      // Fetch all providers that are active (dev-only filtered in routing logic)
      const allProviders = await prisma.paymentProvider.findMany({
        where: { isActive: true },
        orderBy: { priority: 'asc' },
        select: {
          id: true,
          name: true,
          displayName: true,
          checkoutDisplayName: true,
          checkoutDescription: true,
          adapterType: true,
          coverageType: true,
          environment: true,
          priority: true,
          logoUrl: true,
          iconUrl: true,
          brandColor: true,
          supportedCurrencies: true,
          supportedCountries: true,
          supportedRegions: true,
          excludedCountries: true,
          allowCurrencyConversion: true,
          isDevelopmentOnly: true
        }
      });

      const result = resolveCheckoutProviders({
        countryCode,
        currency,
        regionCode,
        includeDevelopment,
        providers: allProviders,
        rule
      });

      return {
        data: result.providers.map((provider) => attachCheckoutProviderReadiness(provider)),
        meta: {
          countryCode,
          currency,
          effectiveRegionCode: regionCode ?? rule?.regionCode ?? null,
          appliedPolicy: result.appliedPolicy,
          countryRule: result.countryRule
        }
      };
    }
  );
};
