import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { redactSensitiveData } from '../../utils/redaction.js';

export const callbackLogRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/callbacks',
    { preHandler: [requireAdminAuth, requirePermission('callbacks:read')] },
    async () => {
      const rows = await prisma.callbackLog.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' }
      });

      return {
        data: rows.map((row) => ({
          ...row,
          requestBody: redactSensitiveData(row.requestBody),
          responseBody: redactSensitiveData(row.responseBody)
        }))
      };
    }
  );
};
