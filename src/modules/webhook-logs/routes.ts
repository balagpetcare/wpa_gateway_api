import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { redactSensitiveData } from '../../utils/redaction.js';

export const webhookLogRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/webhooks',
    { preHandler: [requireAdminAuth, requirePermission('webhooks:read')] },
    async () => {
      const rows = await prisma.webhookLog.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' }
      });

      return {
        data: rows.map((row) => ({
          ...row,
          requestHeaders: redactSensitiveData(row.requestHeaders),
          rawPayload: redactSensitiveData(row.rawPayload)
        }))
      };
    }
  );
};
