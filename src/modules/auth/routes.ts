import bcrypt from 'bcrypt';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { validateBody } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { adminPermissions } from '../../utils/permissions.js';

const loginSchema = z.object({
  emailOrUsername: z.string().min(1, 'Email or username is required'),
  password: z.string().min(1, 'Password is required')
});

const refreshSchema = z.object({
  refresh_token: z.string().min(20)
});

const deriveNameFromEmail = (email: string): string => {
  const namePart = email.split('@')[0] ?? '';
  return namePart.split(/[._-]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
};

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/admin/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (request) => request.ip
      }
    },
    preValidation: validateBody(loginSchema)
  }, async (request, reply) => {
    const { emailOrUsername, password } = request.body as z.infer<typeof loginSchema>;

    // Support both email and username (email prefix before @)
    const admin = emailOrUsername.includes('@')
      ? await prisma.adminUser.findUnique({ where: { email: emailOrUsername } })
      : await prisma.adminUser.findFirst({ where: { email: { startsWith: `${emailOrUsername}@` } } });

    if (!admin || !admin.isActive || !(await bcrypt.compare(password, admin.passwordHash))) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    const accessToken = await reply.jwtSign({
      sub: admin.id,
      email: admin.email,
      role: admin.role
    });

    const refreshToken = await reply.jwtSign(
      { sub: admin.id, type: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { refreshTokenHash: await bcrypt.hash(refreshToken, 12) }
    });

    const permissions = (adminPermissions[admin.role as keyof typeof adminPermissions] as readonly string[]) ?? [];

    return reply.status(200).send({
      success: true,
      token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: admin.id,
        name: deriveNameFromEmail(admin.email),
        email: admin.email,
        role: admin.role,
        permissions
      }
    });
  });

  app.get('/admin/auth/me', {
    preHandler: [requireAdminAuth]
  }, async (request) => {
    const { id, email, role } = request.adminUser!;
    const permissions = (adminPermissions[role as keyof typeof adminPermissions] as readonly string[]) ?? [];

    return {
      success: true,
      user: {
        id,
        name: deriveNameFromEmail(email),
        email,
        role,
        permissions
      }
    };
  });

  app.post('/admin/auth/logout', {
    preHandler: [requireAdminAuth]
  }, async (request, reply) => {
    await prisma.adminUser.update({
      where: { id: request.adminUser!.id },
      data: { refreshTokenHash: null }
    });

    return reply.status(200).send({ success: true });
  });

  app.post('/admin/auth/refresh', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (request) => request.ip
      }
    },
    preValidation: validateBody(refreshSchema)
  }, async (request, reply) => {
    const { refresh_token: refreshToken } = request.body as z.infer<typeof refreshSchema>;
    const decoded = await app.jwt.verify<{ sub: string; type?: string }>(refreshToken);

    if (decoded.type !== 'refresh') {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: decoded.sub }
    });

    if (!admin?.refreshTokenHash || !(await bcrypt.compare(refreshToken, admin.refreshTokenHash))) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
    }

    const accessToken = await reply.jwtSign({
      sub: admin.id,
      email: admin.email,
      role: admin.role
    });

    return {
      success: true,
      token: accessToken
    };
  });
};
