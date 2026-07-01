import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { adminPermissions, hasPermission } from '../../utils/permissions.js';
import { prisma } from '../../config/prisma.js';
import { z } from 'zod';
import { validateBody } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { AdminRole } from '@prisma/client';

const createAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.nativeEnum(AdminRole),
  isActive: z.boolean().optional().default(true)
});

const updateAdminSchema = z.object({
  email: z.string().email().optional(),
  role: z.nativeEnum(AdminRole).optional(),
  isActive: z.boolean().optional()
});

const inviteAdminSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(AdminRole)
});

const toggleStatusSchema = z.object({
  isActive: z.boolean()
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // Legacy / existing endpoint
  app.get(
    '/admin/admins/roles',
    {
      preHandler: [requireAdminAuth, requirePermission('roles.read')]
    },
    async () => ({
      data: Object.entries(adminPermissions).map(([role, permissions]) => ({
        role,
        permissions
      }))
    })
  );

  // --- Handlers ---

  // 1. GET admin-users
  const getAdminUsers = async () => {
    const admins = await prisma.adminUser.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const sessions = await prisma.adminSession.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const invitations = await prisma.adminInvitation.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const userList = admins.map(u => {
      const lastSession = sessions.find(s => s.adminId === u.id);
      const namePart = u.email.split('@')[0] || '';
      const name = namePart.split(/[\._-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
      
      return {
        id: u.id,
        name,
        email: u.email,
        role: u.role,
        status: u.isActive ? 'Active' : 'Suspended',
        date: lastSession ? lastSession.createdAt.toISOString().replace('T', ' ').slice(0, 16) : 'Never',
        type: 'USER',
        activeSessionsCount: sessions.filter(s => s.adminId === u.id && s.expiresAt > new Date()).length
      };
    });

    const inviteList = invitations.map(i => {
      const namePart = i.email.split('@')[0] || '';
      const name = namePart.split(/[\._-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');

      return {
        id: i.id,
        name,
        email: i.email,
        role: i.role,
        status: 'Pending Invitation',
        date: 'Never',
        type: 'INVITATION',
        activeSessionsCount: 0
      };
    });

    return {
      data: [...userList, ...inviteList]
    };
  };

  // 2. GET admin-users/:id
  const getAdminUserById = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const admin = await prisma.adminUser.findUnique({
      where: { id }
    });
    if (!admin) {
      throw new ApiError(404, 'NOT_FOUND', 'Admin user not found');
    }
    return {
      data: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        isActive: admin.isActive,
        createdAt: admin.createdAt
      }
    };
  };

  // 3. POST admin-users
  const createAdminUser = async (request: FastifyRequest) => {
    const actor = request.adminUser!;
    const body = request.body as z.infer<typeof createAdminSchema>;

    // Guardrail: Role assignment requires authorization
    const newRole = body.role;
    if (newRole === 'SUPER_ADMIN' || newRole === 'ADMIN') {
      const canChange = actor.role === 'SUPER_ADMIN' || (actor.role === 'ADMIN' && hasPermission(actor.role, 'roles.update'));
      if (!canChange) {
        throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions to assign SUPER_ADMIN or ADMIN roles');
      }
    }

    const existing = await prisma.adminUser.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new ApiError(409, 'CONFLICT', 'Email already in use');
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    const admin = await prisma.adminUser.create({
      data: {
        email: body.email,
        passwordHash,
        role: body.role,
        isActive: body.isActive
      }
    });

    return {
      data: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        isActive: admin.isActive
      }
    };
  };

  // 4. PATCH admin-users/:id
  const updateAdminUser = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const actor = request.adminUser!;
    const body = request.body as z.infer<typeof updateAdminSchema>;

    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) {
      throw new ApiError(404, 'NOT_FOUND', 'Admin user not found');
    }

    // Guardrail: User cannot change their own role or status
    if (target.id === actor.id) {
      if (body.role && body.role !== target.role) {
        throw new ApiError(403, 'FORBIDDEN', 'You cannot change your own role');
      }
      if (body.isActive !== undefined && body.isActive !== target.isActive) {
        throw new ApiError(403, 'FORBIDDEN', 'You cannot suspend or change your own active status');
      }
    }

    // Guardrail: Last active SUPER_ADMIN cannot be suspended or changed to another role
    if (target.role === 'SUPER_ADMIN') {
      const isChangingRole = body.role && body.role !== 'SUPER_ADMIN';
      const isSuspending = body.isActive === false && target.isActive === true;
      if (isChangingRole || isSuspending) {
        const superAdminCount = await prisma.adminUser.count({
          where: { role: 'SUPER_ADMIN', isActive: true }
        });
        if (superAdminCount <= 1) {
          throw new ApiError(403, 'FORBIDDEN', 'Cannot modify the last active SUPER_ADMIN');
        }
      }
    }

    // Guardrail: Role change requires authorization
    if (body.role && body.role !== target.role) {
      const canChange = actor.role === 'SUPER_ADMIN' || (actor.role === 'ADMIN' && hasPermission(actor.role, 'roles.update'));
      if (!canChange) {
        throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions to change user role');
      }
    }

    if (body.email && body.email !== target.email) {
      const existing = await prisma.adminUser.findUnique({ where: { email: body.email } });
      if (existing) {
        throw new ApiError(409, 'CONFLICT', 'Email already in use');
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data: {
        email: body.email,
        role: body.role,
        isActive: body.isActive
      }
    });

    return {
      data: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        isActive: updated.isActive
      }
    };
  };

  // 5. DELETE admin-users/:id
  const deleteAdminUser = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const actor = request.adminUser!;

    // Guardrail: A user cannot delete their own account
    if (id === actor.id) {
      throw new ApiError(403, 'FORBIDDEN', 'You cannot delete your own account');
    }

    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) {
      // Check if target is a pending invitation
      const invitation = await prisma.adminInvitation.findUnique({ where: { id } });
      if (invitation) {
        await prisma.adminInvitation.delete({ where: { id } });
        return { success: true, message: 'Invitation deleted successfully' };
      }
      throw new ApiError(404, 'NOT_FOUND', 'Admin user not found');
    }

    // Guardrail: The last active SUPER_ADMIN cannot be deleted
    if (target.role === 'SUPER_ADMIN') {
      const superAdminCount = await prisma.adminUser.count({
        where: { role: 'SUPER_ADMIN', isActive: true }
      });
      if (superAdminCount <= 1) {
        throw new ApiError(403, 'FORBIDDEN', 'Cannot delete the last active SUPER_ADMIN');
      }
    }

    await prisma.adminUser.delete({ where: { id } });

    return {
      success: true,
      message: 'Admin user deleted successfully'
    };
  };

  // 6. PATCH admin-users/:id/status
  const toggleAdminUserStatus = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const actor = request.adminUser!;
    const { isActive } = request.body as z.infer<typeof toggleStatusSchema>;

    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) {
      throw new ApiError(404, 'NOT_FOUND', 'Admin user not found');
    }

    // Guardrail: A user cannot suspend their own account
    if (target.id === actor.id && !isActive) {
      throw new ApiError(403, 'FORBIDDEN', 'You cannot suspend your own account');
    }

    // Guardrail: The last active SUPER_ADMIN cannot be suspended
    if (target.role === 'SUPER_ADMIN' && !isActive) {
      const superAdminCount = await prisma.adminUser.count({
        where: { role: 'SUPER_ADMIN', isActive: true }
      });
      if (superAdminCount <= 1) {
        throw new ApiError(403, 'FORBIDDEN', 'Cannot suspend the last active SUPER_ADMIN');
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data: { isActive }
    });

    return {
      data: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        isActive: updated.isActive
      }
    };
  };

  // 7. POST admin-users/invite
  const inviteAdminUser = async (request: FastifyRequest) => {
    const actor = request.adminUser!;
    const body = request.body as z.infer<typeof inviteAdminSchema>;

    // Guardrail: Role assignment authorization
    const assignedRole = body.role;
    if (assignedRole === 'SUPER_ADMIN' || assignedRole === 'ADMIN') {
      const canChange = actor.role === 'SUPER_ADMIN' || (actor.role === 'ADMIN' && hasPermission(actor.role, 'roles.update'));
      if (!canChange) {
        throw new ApiError(403, 'FORBIDDEN', 'Insufficient privileges to invite SUPER_ADMIN or ADMIN roles');
      }
    }

    // Check if user already exists
    const existingUser = await prisma.adminUser.findUnique({ where: { email: body.email } });
    if (existingUser) {
      throw new ApiError(409, 'CONFLICT', 'Admin user with this email already exists');
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration

    const invitation = await prisma.adminInvitation.upsert({
      where: { email: body.email },
      update: {
        role: body.role,
        token: inviteToken,
        invitedById: actor.id,
        expiresAt
      },
      create: {
        email: body.email,
        role: body.role,
        token: inviteToken,
        invitedById: actor.id,
        expiresAt
      }
    });

    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        token: invitation.token,
        expiresAt: invitation.expiresAt
      }
    };
  };

  // 8. GET admin-roles
  const getAdminRoles = async () => {
    const counts = await prisma.adminUser.groupBy({
      by: ['role'],
      _count: { _all: true }
    });

    const roles = Object.keys(adminPermissions).map((role) => {
      const countItem = counts.find((c) => c.role === role);
      const count = countItem?._count._all || 0;
      return {
        id: `ROL-${role}`,
        name: role.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(' '),
        role: role,
        desc: role === 'SUPER_ADMIN' ? 'Full access to all modules and configurations' :
              role === 'ADMIN' ? 'Full access except security rules and last Super Admin deletion' :
              role === 'MANAGER' ? 'Operational data access. No admin security edits.' :
              role === 'SUPPORT' ? 'Read-only access to users, merchants, payments, transactions' :
              role === 'AUDITOR' ? 'Read-only access to logs and analytics' :
              'Developer technical configurations access',
        count: `${count} user${count === 1 ? '' : 's'}`,
        status: 'Active',
        date: '2026-01-01'
      };
    });

    return { data: roles };
  };

  // 9. GET admin-permissions
  const getAdminPermissions = async () => {
    return {
      data: Object.entries(adminPermissions).map(([role, permissions]) => ({
        role,
        permissions
      }))
    };
  };

  // --- Register routes with/without /admin prefix ---

  // GET admin-users
  app.get('/admin-users', { preHandler: [requireAdminAuth, requirePermission('admin_users.read')] }, getAdminUsers);
  app.get('/admin/admin-users', { preHandler: [requireAdminAuth, requirePermission('admin_users.read')] }, getAdminUsers);

  // GET admin-users/:id
  app.get('/admin-users/:id', { preHandler: [requireAdminAuth, requirePermission('admin_users.read')] }, getAdminUserById);
  app.get('/admin/admin-users/:id', { preHandler: [requireAdminAuth, requirePermission('admin_users.read')] }, getAdminUserById);

  // POST admin-users
  app.post('/admin-users', { preHandler: [requireAdminAuth, requirePermission('admin_users.create')], preValidation: validateBody(createAdminSchema) }, createAdminUser);
  app.post('/admin/admin-users', { preHandler: [requireAdminAuth, requirePermission('admin_users.create')], preValidation: validateBody(createAdminSchema) }, createAdminUser);

  // PATCH admin-users/:id
  app.patch('/admin-users/:id', { preHandler: [requireAdminAuth, requirePermission('admin_users.update')], preValidation: validateBody(updateAdminSchema) }, updateAdminUser);
  app.patch('/admin/admin-users/:id', { preHandler: [requireAdminAuth, requirePermission('admin_users.update')], preValidation: validateBody(updateAdminSchema) }, updateAdminUser);

  // DELETE admin-users/:id
  app.delete('/admin-users/:id', { preHandler: [requireAdminAuth, requirePermission('admin_users.delete')] }, deleteAdminUser);
  app.delete('/admin/admin-users/:id', { preHandler: [requireAdminAuth, requirePermission('admin_users.delete')] }, deleteAdminUser);

  // PATCH admin-users/:id/status
  app.patch('/admin-users/:id/status', { preHandler: [requireAdminAuth, requirePermission('admin_users.update')], preValidation: validateBody(toggleStatusSchema) }, toggleAdminUserStatus);
  app.patch('/admin/admin-users/:id/status', { preHandler: [requireAdminAuth, requirePermission('admin_users.update')], preValidation: validateBody(toggleStatusSchema) }, toggleAdminUserStatus);

  // POST admin-users/invite
  app.post('/admin-users/invite', { preHandler: [requireAdminAuth, requirePermission('admin_users.invite')], preValidation: validateBody(inviteAdminSchema) }, inviteAdminUser);
  app.post('/admin/admin-users/invite', { preHandler: [requireAdminAuth, requirePermission('admin_users.invite')], preValidation: validateBody(inviteAdminSchema) }, inviteAdminUser);

  // GET admin-roles
  app.get('/admin-roles', { preHandler: [requireAdminAuth, requirePermission('roles.read')] }, getAdminRoles);
  app.get('/admin/admin-roles', { preHandler: [requireAdminAuth, requirePermission('roles.read')] }, getAdminRoles);

  // GET admin-permissions
  app.get('/admin-permissions', { preHandler: [requireAdminAuth, requirePermission('roles.read')] }, getAdminPermissions);
  app.get('/admin/admin-permissions', { preHandler: [requireAdminAuth, requirePermission('roles.read')] }, getAdminPermissions);
};
