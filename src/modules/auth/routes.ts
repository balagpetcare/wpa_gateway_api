import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody } from '../../utils/validation.js';
import {
  changeAdminPassword,
  consumePasswordResetToken,
  createPasswordResetToken,
  getAuthenticatedAdmin,
  issueTemporaryPassword,
  revokeAllAdminSessions,
  revokeCurrentAdminSession,
  rotateAdminRefreshToken,
  loginAdminWithPassword,
} from './admin-auth-service.js';

const loginSchema = z
  .object({
    email: z.string().email('Enter a valid email address.').optional(),
    emailOrUsername: z.string().trim().min(1, 'Email or username is required').optional(),
    password: z.string().min(1, 'Password is required'),
    rememberMe: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.emailOrUsername) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emailOrUsername'],
        message: 'Email or username is required',
      });
    }
  });

const refreshSchema = z.object({
  refresh_token: z.string().min(20),
});

const logoutSchema = z.object({
  sessionId: z.string().min(1).optional(),
});

const resetTokenSchema = z.object({
  adminUserId: z.string().min(1),
});

const consumeResetTokenSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(12),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/admin/auth/login',
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: '15 minutes',
          keyGenerator: (request) => {
            const body = request.body as { email?: string; emailOrUsername?: string } | undefined;
            const identifier = body?.emailOrUsername ?? body?.email ?? '';
            return `${request.ip}:${String(identifier).toLowerCase()}`;
          },
        },
      },
      preValidation: validateBody(loginSchema),
    },
    async (request, reply) => {
      const { email, emailOrUsername, password, rememberMe } = request.body as z.infer<typeof loginSchema>;
      const result = await loginAdminWithPassword({
        emailOrUsername: emailOrUsername ?? email ?? '',
        password,
        rememberMe,
        request,
      });

      return reply.status(200).send({
        success: true,
        token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_at: result.accessTokenExpiresAt,
        refresh_expires_at: result.refreshTokenExpiresAt,
        session_id: result.sessionId,
        user: result.user,
      });
    },
  );

  app.get(
    '/admin/auth/me',
    {
      preHandler: [requireAdminAuth],
    },
    async (request) => {
      const sessionId = (request.user as { sid?: string } | undefined)?.sid;
      if (!sessionId) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
      }

      const admin = await getAuthenticatedAdmin({
        sub: request.adminUser!.id,
        sid: sessionId,
        email: request.adminUser!.email,
        role: request.adminUser!.role,
        tv: (request.user as { tv?: number }).tv ?? 0,
      });

      return {
        success: true,
        user: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          status: admin.status,
          mustChangePassword: admin.mustChangePassword,
        },
      };
    },
  );

  app.post(
    '/admin/auth/logout',
    {
      preHandler: [requireAdminAuth],
    },
    async (request, reply) => {
      const body = logoutSchema.safeParse(request.body).success ? (request.body as z.infer<typeof logoutSchema>) : {};
      await revokeCurrentAdminSession(request.adminUser!.id, body.sessionId ?? null);
      return reply.status(200).send({ success: true });
    },
  );

  app.post(
    '/admin/auth/logout-all',
    {
      preHandler: [requireAdminAuth],
    },
    async (request, reply) => {
      await revokeAllAdminSessions(request.adminUser!.id);
      return reply.status(200).send({ success: true });
    },
  );

  app.post(
    '/admin/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (request) => request.ip,
        },
      },
      preValidation: validateBody(refreshSchema),
    },
    async (request) => {
      const { refresh_token: refreshToken } = request.body as z.infer<typeof refreshSchema>;
      const result = await rotateAdminRefreshToken(refreshToken, request);

      return {
        success: true,
        token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_at: result.accessTokenExpiresAt,
        refresh_expires_at: result.refreshTokenExpiresAt,
        session_id: result.sessionId,
        user: result.user,
      };
    },
  );

  app.post(
    '/admin/auth/change-password',
    {
      preHandler: [requireAdminAuth],
      preValidation: validateBody(changePasswordSchema),
    },
    async (request) => {
      const sessionId = (request.user as { sid?: string } | undefined)?.sid;
      if (!sessionId) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
      }

      const { currentPassword, newPassword } = request.body as z.infer<typeof changePasswordSchema>;
      const result = await changeAdminPassword({
        adminId: request.adminUser!.id,
        sessionId,
        currentPassword,
        newPassword,
        request,
      });

      return {
        success: true,
        token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_at: result.accessTokenExpiresAt,
        refresh_expires_at: result.refreshTokenExpiresAt,
        session_id: result.sessionId,
        user: result.user,
      };
    },
  );

  app.post(
    '/admin/auth/reset-password',
    {
      preValidation: validateBody(consumeResetTokenSchema),
    },
    async (request, reply) => {
      const { token, newPassword } = request.body as z.infer<typeof consumeResetTokenSchema>;
      await consumePasswordResetToken({
        token,
        newPassword,
        ipAddress: request.ip,
      });

      return reply.status(200).send({ success: true });
    },
  );

  app.post(
    '/admin/auth/password-reset-tokens',
    {
      preHandler: [requireAdminAuth],
      preValidation: validateBody(resetTokenSchema),
    },
    async (request, reply) => {
      if (request.adminUser!.role !== 'SUPER_ADMIN') {
        throw new ApiError(403, 'FORBIDDEN', 'Only super admins can issue password reset tokens.');
      }

      const { adminUserId } = request.body as z.infer<typeof resetTokenSchema>;
      const token = await createPasswordResetToken({
        actorAdminId: request.adminUser!.id,
        targetAdminId: adminUserId,
        ipAddress: request.ip,
      });

      return reply.status(201).send({ success: true, data: token });
    },
  );

  app.post(
    '/admin/auth/temporary-password',
    {
      preHandler: [requireAdminAuth],
      preValidation: validateBody(resetTokenSchema),
    },
    async (request, reply) => {
      if (request.adminUser!.role !== 'SUPER_ADMIN') {
        throw new ApiError(403, 'FORBIDDEN', 'Only super admins can issue temporary passwords.');
      }

      const { adminUserId } = request.body as z.infer<typeof resetTokenSchema>;
      const result = await issueTemporaryPassword({
        actorAdminId: request.adminUser!.id,
        targetAdminId: adminUserId,
        ipAddress: request.ip,
      });

      return reply.status(201).send({ success: true, data: result });
    },
  );
};
