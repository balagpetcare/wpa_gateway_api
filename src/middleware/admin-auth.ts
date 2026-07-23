import type { FastifyReply, FastifyRequest } from 'fastify';

import { getAuthenticatedAdmin, type AccessPayload } from '../modules/auth/admin-auth-service.js';
import { ApiError } from '../utils/errors.js';

type JwtAdminPayload = AccessPayload;

export const requireAdminAuth = async (request: FastifyRequest, _reply: FastifyReply) => {
  let payload: JwtAdminPayload;

  try {
    payload = await request.jwtVerify<JwtAdminPayload>();
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  const admin = await getAuthenticatedAdmin(payload);
  request.adminUser = {
    id: admin.id,
    email: admin.email,
    role: admin.role,
  };
};
