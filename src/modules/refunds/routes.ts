import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { RefundStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateQuery } from '../../utils/validation.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(RefundStatus).optional(),
  merchantId: z.string().optional(),
  transactionId: z.string().optional(),
  providerId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

export const refundRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/refunds',
    {
      preHandler: [requireAdminAuth, requirePermission('refunds:read')],
      preValidation: validateQuery(listQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof listQuerySchema>;

      const where: Record<string, unknown> = {};
      if (q.status) where.status = q.status;
      if (q.merchantId) where.merchantId = q.merchantId;
      if (q.transactionId) where.transactionId = q.transactionId;
      if (q.providerId) where.providerId = q.providerId;

      if (q.dateFrom || q.dateTo) {
        const dateFilter: Record<string, Date> = {};
        if (q.dateFrom) dateFilter.gte = new Date(q.dateFrom);
        if (q.dateTo) {
          const to = new Date(q.dateTo);
          to.setHours(23, 59, 59, 999);
          dateFilter.lte = to;
        }
        where.createdAt = dateFilter;
      }

      const skip = (q.page - 1) * q.limit;

      const [rows, total] = await Promise.all([
        prisma.refund.findMany({
          where,
          orderBy: { createdAt: q.sortOrder },
          skip,
          take: q.limit,
          include: {
            transaction: { select: { id: true, providerReference: true, status: true } },
            merchant: { select: { id: true, name: true } },
            provider: { select: { id: true, name: true, displayName: true } },
            requestedBy: { select: { id: true, email: true, role: true } }
          }
        }),
        prisma.refund.count({ where })
      ]);

      const data = rows.map((r) => ({
        ...r,
        amount: r.amount.toString()
      }));

      return {
        data,
        pagination: {
          total,
          page: q.page,
          limit: q.limit,
          pages: Math.ceil(total / q.limit)
        }
      };
    }
  );
};
