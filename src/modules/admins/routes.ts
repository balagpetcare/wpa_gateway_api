import bcrypt from 'bcrypt';
import type { FastifyPluginAsync } from 'fastify';
import { AdminRole, AdminUserStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { ApiError } from '../../utils/errors.js';
import { adminPermissions } from '../../utils/permissions.js';
import { validateBody, validateQuery } from '../../utils/validation.js';
import { createPasswordResetToken, issueTemporaryPassword, revokeAllAdminSessions } from '../auth/admin-auth-service.js';

const createAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(12),
  role: z.nativeEnum(AdminRole),
  status: z.nativeEnum(AdminUserStatus).optional().default(AdminUserStatus.ACTIVE),
  mustChangePassword: z.boolean().optional().default(false),
});

const updateAdminSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.nativeEnum(AdminRole).optional(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(AdminUserStatus),
});

const adminListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: z.nativeEnum(AdminUserStatus).optional(),
  role: z.nativeEnum(AdminRole).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

const credentialIssueSchema = z.object({
  adminUserId: z.string().min(1),
});

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function countActiveSuperAdmins() {
  return prisma.adminUser.count({
    where: {
      role: AdminRole.SUPER_ADMIN,
      status: AdminUserStatus.ACTIVE,
    },
  });
}

function ensureSuperAdmin(actorRole: AdminRole) {
  if (actorRole !== AdminRole.SUPER_ADMIN) {
    throw new ApiError(403, 'FORBIDDEN', 'Only super admins can manage admin users.');
  }
}

async function ensureTargetAdminExists(id: string) {
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) {
    throw new ApiError(404, 'NOT_FOUND', 'Admin user not found');
  }
  return target;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const requireSuperAdmin = async (request: any) => {
    ensureSuperAdmin(request.adminUser!.role);
  };

  app.get(
    '/admin/admins/roles',
    {
      preHandler: [requireAdminAuth, requireSuperAdmin],
    },
    async () => ({
      data: Object.entries(adminPermissions).map(([role, permissions]) => ({
        role,
        permissions,
      })),
    }),
  );

  const getAdminUsers = async (request: any) => {
    ensureSuperAdmin(request.adminUser!.role);

    const query = request.query as z.infer<typeof adminListQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const search = query.search?.trim();

    const where = {
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search.toLowerCase(), mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { role: query.role } : {}),
    };

    const [total, admins] = await Promise.all([
      prisma.adminUser.count({ where }),
      prisma.adminUser.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          sessions: {
            where: {
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            orderBy: { updatedAt: 'desc' },
            take: 5,
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
    ]);

    return {
      data: admins.map((admin) => ({
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        status: admin.status,
        mustChangePassword: admin.mustChangePassword,
        failedLoginCount: admin.failedLoginCount,
        lockedUntil: admin.lockedUntil,
        lastLoginAt: admin.lastLoginAt,
        lastLoginIp: admin.lastLoginIp,
        activeSessionsCount: admin.sessions.length,
        createdAt: admin.createdAt,
        createdBy: admin.createdBy,
      })),
      pagination: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  };

  const getAdminUserById = async (request: any) => {
    ensureSuperAdmin(request.adminUser!.role);

    const { id } = request.params as { id: string };
    const admin = await prisma.adminUser.findUnique({
      where: { id },
      include: {
        sessions: {
          orderBy: { updatedAt: 'desc' },
          take: 20,
        },
        securityAuditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!admin) {
      throw new ApiError(404, 'NOT_FOUND', 'Admin user not found');
    }

    return {
      data: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        status: admin.status,
        mustChangePassword: admin.mustChangePassword,
        failedLoginCount: admin.failedLoginCount,
        lockedUntil: admin.lockedUntil,
        lastLoginAt: admin.lastLoginAt,
        lastLoginIp: admin.lastLoginIp,
        createdAt: admin.createdAt,
        sessions: admin.sessions,
        securityHistory: admin.securityAuditLogs,
      },
    };
  };

  const createAdminUser = async (request: any, reply: any) => {
    const actor = request.adminUser!;
    ensureSuperAdmin(actor.role);

    const body = request.body as z.infer<typeof createAdminSchema>;
    const email = normalizeEmail(body.email);
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, 'CONFLICT', 'Email already in use.');
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    const admin = await prisma.adminUser.create({
      data: {
        name: body.name.trim(),
        email,
        passwordHash,
        role: body.role,
        status: body.status,
        mustChangePassword: body.mustChangePassword,
        createdById: actor.id,
      },
    });

    return reply.status(201).send({
      data: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        status: admin.status,
        mustChangePassword: admin.mustChangePassword,
      },
    });
  };

  const updateAdminUser = async (request: any) => {
    const actor = request.adminUser!;
    ensureSuperAdmin(actor.role);

    const { id } = request.params as { id: string };
    const body = request.body as z.infer<typeof updateAdminSchema>;
    const target = await ensureTargetAdminExists(id);

    if (body.role && target.id === actor.id && target.role === AdminRole.SUPER_ADMIN && body.role !== AdminRole.SUPER_ADMIN) {
      const count = await countActiveSuperAdmins();
      if (count <= 1) {
        throw new ApiError(403, 'FORBIDDEN', 'Cannot self-demote the final active super admin.');
      }
    }

    if (
      body.role &&
      target.role === AdminRole.SUPER_ADMIN &&
      body.role !== AdminRole.SUPER_ADMIN &&
      target.status === AdminUserStatus.ACTIVE
    ) {
      const count = await countActiveSuperAdmins();
      if (count <= 1) {
        throw new ApiError(403, 'FORBIDDEN', 'Cannot demote the final active super admin.');
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.role ? { role: body.role } : {}),
      },
    });

    return {
      data: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        status: updated.status,
      },
    };
  };

  const updateAdminStatus = async (request: any) => {
    const actor = request.adminUser!;
    ensureSuperAdmin(actor.role);

    const { id } = request.params as { id: string };
    const { status } = request.body as z.infer<typeof updateStatusSchema>;
    const target = await ensureTargetAdminExists(id);

    if (target.role === AdminRole.SUPER_ADMIN && status !== AdminUserStatus.ACTIVE && target.status === AdminUserStatus.ACTIVE) {
      const count = await countActiveSuperAdmins();
      if (count <= 1) {
        throw new ApiError(403, 'FORBIDDEN', 'Cannot disable the final active super admin.');
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data: { status },
    });

    if (status !== AdminUserStatus.ACTIVE) {
      await revokeAllAdminSessions(updated.id);
    }

    return {
      data: {
        id: updated.id,
        status: updated.status,
      },
    };
  };

  const revokeSessions = async (request: any, reply: any) => {
    ensureSuperAdmin(request.adminUser!.role);
    const { id } = request.params as { id: string };
    await ensureTargetAdminExists(id);
    await revokeAllAdminSessions(id);
    return reply.status(200).send({ success: true });
  };

  const issueResetToken = async (request: any, reply: any) => {
    ensureSuperAdmin(request.adminUser!.role);
    const { adminUserId } = request.body as z.infer<typeof credentialIssueSchema>;
    await ensureTargetAdminExists(adminUserId);

    const token = await createPasswordResetToken({
      actorAdminId: request.adminUser!.id,
      targetAdminId: adminUserId,
      ipAddress: request.ip,
    });

    return reply.status(201).send({ success: true, data: token });
  };

  const issueTemporaryPasswordAction = async (request: any, reply: any) => {
    ensureSuperAdmin(request.adminUser!.role);
    const { adminUserId } = request.body as z.infer<typeof credentialIssueSchema>;
    await ensureTargetAdminExists(adminUserId);

    const result = await issueTemporaryPassword({
      actorAdminId: request.adminUser!.id,
      targetAdminId: adminUserId,
      ipAddress: request.ip,
    });

    return reply.status(201).send({ success: true, data: result });
  };

  app.get('/admin-users', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateQuery(adminListQuerySchema) }, getAdminUsers);
  app.get('/admin/admin-users', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateQuery(adminListQuerySchema) }, getAdminUsers);
  app.get('/admin-users/:id', { preHandler: [requireAdminAuth, requireSuperAdmin] }, getAdminUserById);
  app.get('/admin/admin-users/:id', { preHandler: [requireAdminAuth, requireSuperAdmin] }, getAdminUserById);
  app.post('/admin-users', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(createAdminSchema) }, createAdminUser);
  app.post('/admin/admin-users', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(createAdminSchema) }, createAdminUser);
  app.patch('/admin-users/:id', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(updateAdminSchema) }, updateAdminUser);
  app.patch('/admin/admin-users/:id', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(updateAdminSchema) }, updateAdminUser);
  app.patch('/admin-users/:id/status', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(updateStatusSchema) }, updateAdminStatus);
  app.patch('/admin/admin-users/:id/status', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(updateStatusSchema) }, updateAdminStatus);
  app.post('/admin-users/:id/revoke-sessions', { preHandler: [requireAdminAuth, requireSuperAdmin] }, revokeSessions);
  app.post('/admin/admin-users/:id/revoke-sessions', { preHandler: [requireAdminAuth, requireSuperAdmin] }, revokeSessions);
  app.post('/admin-users/password-reset-token', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(credentialIssueSchema) }, issueResetToken);
  app.post('/admin/admin-users/password-reset-token', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(credentialIssueSchema) }, issueResetToken);
  app.post('/admin-users/temporary-password', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(credentialIssueSchema) }, issueTemporaryPasswordAction);
  app.post('/admin/admin-users/temporary-password', { preHandler: [requireAdminAuth, requireSuperAdmin], preValidation: validateBody(credentialIssueSchema) }, issueTemporaryPasswordAction);
};
