import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/errors.js';

type JwtAdminPayload = {
  sub: string;
  email: string;
  role: string;
};

export const requireAdminAuth = async (request: FastifyRequest, _reply: FastifyReply) => {
  try {
    const payload = await request.jwtVerify<JwtAdminPayload>();
    const admin = await prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isActive: true }
    });

    if (!admin || !admin.isActive) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
    }

    request.adminUser = {
      id: admin.id,
      email: admin.email,
      role: admin.role
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }
};
