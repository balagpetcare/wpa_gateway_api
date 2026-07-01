import type { FastifyRequest } from 'fastify';
import { ApiError } from '../utils/errors.js';
import { hasPermission } from '../utils/permissions.js';

export const requirePermission =
  (permission: string) =>
  async (request: FastifyRequest) => {
    const adminUser = request.adminUser;

    if (!adminUser) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication required');
    }

    if (!hasPermission(adminUser.role, permission)) {
      throw new ApiError(403, 'FORBIDDEN', 'Admin permission denied');
    }
  };
