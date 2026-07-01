import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateQuery } from '../../utils/validation.js';

const auditQuerySchema = z.object({
  actor_id: z.string().optional(),
  action: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

export const auditLogRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/audit',
    {
      preHandler: [requireAdminAuth, requirePermission('audit:read')],
      preValidation: validateQuery(auditQuerySchema)
    },
    async (request) => {
      const { actor_id, action, entity_type, entity_id, page, limit } = request.query as z.infer<typeof auditQuerySchema>;
      const where = {
        ...(actor_id ? { actorId: actor_id } : {}),
        ...(action ? { action } : {}),
        ...(entity_type ? { entityType: entity_type } : {}),
        ...(entity_id ? { entityId: entity_id } : {})
      };

      const [data, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: 'desc' }
        }),
        prisma.auditLog.count({ where })
      ]);

      return { data, total, page, limit };
    }
  );
};
