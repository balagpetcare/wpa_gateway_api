import crypto from 'node:crypto';

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { AdminRole, AdminUserStatus, type AdminSession, type AdminUser } from '@prisma/client';

import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { adminPermissions } from '../../utils/permissions.js';

type LoginResult = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  sessionId: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: AdminRole;
    permissions: string[];
    mustChangePassword: boolean;
    status: AdminUserStatus;
  };
};

type RefreshPayload = {
  sub: string;
  sid: string;
  jti: string;
  tv: number;
  type: 'refresh';
};

type AccessPayload = {
  sub: string;
  sid: string;
  email: string;
  role: AdminRole;
  tv: number;
};

type SessionWithAdmin = AdminSession & { admin: AdminUser };

export type { AccessPayload };

const accessTokenTtl = env.GATEWAY_ADMIN_ACCESS_TOKEN_TTL || env.JWT_EXPIRES_IN;
const refreshTokenTtl = env.GATEWAY_ADMIN_REFRESH_TOKEN_TTL || env.JWT_REFRESH_EXPIRES_IN;
const nonRememberRefreshTokenTtl = '1d';

const durationPattern = /^(\d+)(ms|s|m|h|d)$/i;
const passwordPolicy = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{12,}$/;

function parseDurationToMs(value: string): number {
  const match = durationPattern.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration: ${value}`);
  }

  const amount = Number(match[1] ?? '0');
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multiplier =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;

  return amount * multiplier;
}

function getRefreshTokenTtlMs(rememberMe: boolean): number {
  const configuredMs = parseDurationToMs(refreshTokenTtl);
  if (rememberMe) {
    return configuredMs;
  }

  return Math.min(configuredMs, parseDurationToMs(nonRememberRefreshTokenTtl));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findAdminForLogin(identifier: string) {
  const normalizedIdentifier = identifier.trim().toLowerCase();

  if (!normalizedIdentifier) {
    return null;
  }

  if (normalizedIdentifier.includes('@')) {
    return prisma.adminUser.findUnique({
      where: { email: normalizedIdentifier },
    });
  }

  return prisma.adminUser.findFirst({
    where: {
      OR: [
        { email: { startsWith: `${normalizedIdentifier}@`, mode: 'insensitive' } },
        { name: { equals: identifier.trim(), mode: 'insensitive' } },
      ],
    },
  });
}

function getPermissions(role: AdminRole): string[] {
  return [...((adminPermissions[role] as readonly string[] | undefined) ?? [])];
}

function getRequestIp(request: FastifyRequest): string | null {
  return request.ip || null;
}

function assertStrongPassword(password: string) {
  if (!passwordPolicy.test(password)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Password must be at least 12 characters and include upper, lower, number, and symbol.',
    );
  }
}

function signAccessToken(payload: AccessPayload) {
  const expiresInMs = parseDurationToMs(accessTokenTtl);
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: accessTokenTtl as any });

  return {
    token,
    expiresAt: Date.now() + expiresInMs,
  };
}

function signRefreshToken(payload: RefreshPayload, rememberMe: boolean) {
  const expiresIn = rememberMe ? refreshTokenTtl : nonRememberRefreshTokenTtl;
  const expiresInMs = rememberMe ? getRefreshTokenTtlMs(true) : getRefreshTokenTtlMs(false);
  const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: expiresIn as any });

  return {
    token,
    expiresAt: Date.now() + expiresInMs,
  };
}

function verifyRefreshToken(refreshToken: string): RefreshPayload {
  try {
    return jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as RefreshPayload;
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
  }
}

async function recordAdminAuditLog(params: {
  action: string;
  actorAdminId?: string | null;
  targetAdminId?: string | null;
  entityId?: string | null;
  entityType: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.adminAuditLog.create({
    data: {
      action: params.action,
      actorAdminId: params.actorAdminId ?? null,
      targetAdminId: params.targetAdminId ?? null,
      entityId: params.entityId ?? null,
      entityType: params.entityType,
      ipAddress: params.ipAddress ?? null,
      metadata: params.metadata as any,
    },
  });
}

function ensureAccountCanAuthenticate(admin: Pick<AdminUser, 'status' | 'lockedUntil'>) {
  if (admin.status === AdminUserStatus.SUSPENDED) {
    throw new ApiError(403, 'FORBIDDEN', 'Your account has been suspended.');
  }

  if (admin.status === AdminUserStatus.DISABLED) {
    throw new ApiError(403, 'FORBIDDEN', 'Your account has been disabled.');
  }

  if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
    throw new ApiError(429, 'FORBIDDEN', 'Too many login attempts. Please try again later.');
  }
}

async function registerFailedLogin(admin: Pick<AdminUser, 'id' | 'failedLoginCount'>) {
  const nextFailedCount = admin.failedLoginCount + 1;
  const shouldLock = nextFailedCount >= env.GATEWAY_ADMIN_LOGIN_MAX_FAILURES;

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      failedLoginCount: nextFailedCount,
      lockedUntil: shouldLock ? new Date(Date.now() + env.GATEWAY_ADMIN_LOGIN_LOCK_MINUTES * 60_000) : null,
    },
  });
}

async function clearFailedLoginState(adminId: string, ipAddress: string | null) {
  await prisma.adminUser.update({
    where: { id: adminId },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress,
    },
  });
}

async function buildLoginResultFromSessionAdmin(session: SessionWithAdmin, tokenVersion: number) {
  const nextSessionTokenId = crypto.randomUUID();
  const refresh = signRefreshToken(
    {
      sub: session.admin.id,
      sid: session.id,
      jti: nextSessionTokenId,
      tv: tokenVersion,
      type: 'refresh',
    },
    session.rememberMe,
  );
  const access = signAccessToken({
    sub: session.admin.id,
    sid: session.id,
    email: session.admin.email,
    role: session.admin.role,
    tv: tokenVersion,
  });

  await prisma.adminSession.update({
    where: { id: session.id },
    data: {
      sessionTokenId: nextSessionTokenId,
      refreshTokenHash: await bcrypt.hash(refresh.token, 12),
      expiresAt: new Date(refresh.expiresAt),
      lastUsedAt: new Date(),
    },
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    sessionId: session.id,
    user: {
      id: session.admin.id,
      name: session.admin.name,
      email: session.admin.email,
      role: session.admin.role,
      permissions: getPermissions(session.admin.role),
      mustChangePassword: session.admin.mustChangePassword,
      status: session.admin.status,
    },
  } satisfies LoginResult;
}

async function revokeAdminSessionsByFilter(where: Parameters<typeof prisma.adminSession.updateMany>[0]['where']) {
  await prisma.adminSession.updateMany({
    where: {
      ...where,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

export async function loginAdminWithPassword(input: {
  emailOrUsername: string;
  password: string;
  rememberMe: boolean;
  request: FastifyRequest;
}): Promise<LoginResult> {
  const admin = await findAdminForLogin(input.emailOrUsername);

  if (!admin) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password.');
  }

  ensureAccountCanAuthenticate(admin);

  const passwordMatches = await bcrypt.compare(input.password, admin.passwordHash);
  if (!passwordMatches) {
    await registerFailedLogin(admin);
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password.');
  }

  await clearFailedLoginState(admin.id, getRequestIp(input.request));

  const sessionTokenId = crypto.randomUUID();
  const refreshPayload: RefreshPayload = {
    sub: admin.id,
    sid: crypto.randomUUID(),
    jti: sessionTokenId,
    tv: admin.tokenVersion,
    type: 'refresh',
  };
  const refresh = signRefreshToken(refreshPayload, input.rememberMe);
  const access = signAccessToken({
    sub: admin.id,
    sid: refreshPayload.sid,
    email: admin.email,
    role: admin.role,
    tv: admin.tokenVersion,
  });

  await prisma.adminSession.create({
    data: {
      id: refreshPayload.sid,
      adminId: admin.id,
      sessionTokenId,
      refreshTokenHash: await bcrypt.hash(refresh.token, 12),
      rememberMe: input.rememberMe,
      userAgent: input.request.headers['user-agent'] ?? null,
      ipAddress: getRequestIp(input.request),
      expiresAt: new Date(refresh.expiresAt),
      lastUsedAt: new Date(),
    },
  });

  await recordAdminAuditLog({
    action: 'ADMIN_LOGIN_SUCCEEDED',
    actorAdminId: admin.id,
    targetAdminId: admin.id,
    entityId: admin.id,
    entityType: 'AdminUser',
    ipAddress: getRequestIp(input.request),
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshTokenExpiresAt: refresh.expiresAt,
    sessionId: refreshPayload.sid,
    user: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: getPermissions(admin.role),
      mustChangePassword: admin.mustChangePassword,
      status: admin.status,
    },
  };
}

export async function rotateAdminRefreshToken(refreshToken: string, request: FastifyRequest) {
  const decoded = verifyRefreshToken(refreshToken);
  if (decoded.type !== 'refresh') {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
  }

  const session = await prisma.adminSession.findUnique({
    where: { id: decoded.sid },
    include: { admin: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
  }

  if (session.sessionTokenId !== decoded.jti) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
  }

  if (!(await bcrypt.compare(refreshToken, session.refreshTokenHash))) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
  }

  ensureAccountCanAuthenticate(session.admin);

  if (session.admin.tokenVersion !== decoded.tv) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid refresh token');
  }

  await prisma.adminSession.update({
    where: { id: session.id },
    data: {
      lastUsedAt: new Date(),
      ipAddress: getRequestIp(request),
      userAgent: request.headers['user-agent'] ?? null,
    },
  });

  return buildLoginResultFromSessionAdmin(session, session.admin.tokenVersion);
}

export async function getAuthenticatedAdmin(accessPayload: AccessPayload) {
  const session = await prisma.adminSession.findUnique({
    where: { id: accessPayload.sid },
    include: { admin: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  ensureAccountCanAuthenticate(session.admin);

  if (session.admin.tokenVersion !== accessPayload.tv) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  return session.admin;
}

export async function revokeCurrentAdminSession(adminId: string, sessionId?: string | null) {
  if (!sessionId) {
    await revokeAdminSessionsByFilter({ adminId });
    return;
  }

  await revokeAdminSessionsByFilter({ id: sessionId, adminId });
}

export async function revokeAllAdminSessions(adminId: string) {
  await prisma.adminUser.update({
    where: { id: adminId },
    data: {
      tokenVersion: {
        increment: 1,
      },
    },
  });

  await revokeAdminSessionsByFilter({ adminId });
}

export async function createPasswordResetToken(input: {
  actorAdminId: string;
  targetAdminId: string;
  ipAddress?: string | null;
}) {
  const secret = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + parseDurationToMs(env.GATEWAY_ADMIN_PASSWORD_RESET_TOKEN_TTL));

  await prisma.passwordResetToken.updateMany({
    where: {
      adminId: input.targetAdminId,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: {
      usedAt: new Date(),
    },
  });

  const record = await prisma.passwordResetToken.create({
    data: {
      adminId: input.targetAdminId,
      tokenHash: await bcrypt.hash(secret, 12),
      expiresAt,
      createdById: input.actorAdminId,
    },
  });

  await recordAdminAuditLog({
    action: 'ADMIN_PASSWORD_RESET_TOKEN_CREATED',
    actorAdminId: input.actorAdminId,
    targetAdminId: input.targetAdminId,
    entityId: input.targetAdminId,
    entityType: 'AdminUser',
    ipAddress: input.ipAddress ?? null,
  });

  return {
    temporaryPasswordResetToken: `${record.id}.${secret}`,
    expiresAt,
  };
}

export async function consumePasswordResetToken(input: { token: string; newPassword: string; ipAddress?: string | null }) {
  const [tokenId, secret] = input.token.split('.');
  if (!tokenId || !secret) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired password reset token.');
  }

  assertStrongPassword(input.newPassword);

  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { id: tokenId },
    include: { admin: true },
  });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired password reset token.');
  }

  if (!(await bcrypt.compare(secret, resetToken.tokenHash))) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired password reset token.');
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);

  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.adminUser.update({
      where: { id: resetToken.admin.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.adminSession.updateMany({
      where: { adminId: resetToken.admin.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordAdminAuditLog({
    action: 'ADMIN_PASSWORD_RESET_COMPLETED',
    targetAdminId: resetToken.admin.id,
    entityId: resetToken.admin.id,
    entityType: 'AdminUser',
    ipAddress: input.ipAddress ?? null,
  });

  return { success: true };
}

export async function issueTemporaryPassword(input: {
  actorAdminId: string;
  targetAdminId: string;
  ipAddress?: string | null;
}) {
  const temporaryPassword = crypto.randomBytes(12).toString('base64url');
  assertStrongPassword(`${temporaryPassword}A!1`);
  const finalTemporaryPassword = `${temporaryPassword}A!1`;
  const passwordHash = await bcrypt.hash(finalTemporaryPassword, 12);

  await prisma.adminUser.update({
    where: { id: input.targetAdminId },
    data: {
      passwordHash,
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
      status: AdminUserStatus.ACTIVE,
      tokenVersion: { increment: 1 },
    },
  });

  await revokeAdminSessionsByFilter({ adminId: input.targetAdminId });

  await recordAdminAuditLog({
    action: 'ADMIN_TEMPORARY_PASSWORD_ISSUED',
    actorAdminId: input.actorAdminId,
    targetAdminId: input.targetAdminId,
    entityId: input.targetAdminId,
    entityType: 'AdminUser',
    ipAddress: input.ipAddress ?? null,
  });

  return {
    temporaryPassword: finalTemporaryPassword,
  };
}

export async function changeAdminPassword(input: {
  adminId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  request: FastifyRequest;
}) {
  if (input.currentPassword === input.newPassword) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'New password must be different from the current password.');
  }

  assertStrongPassword(input.newPassword);

  const session = await prisma.adminSession.findUnique({
    where: { id: input.sessionId },
    include: { admin: true },
  });

  if (!session || session.adminId !== input.adminId || session.revokedAt) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  const passwordMatches = await bcrypt.compare(input.currentPassword, session.admin.passwordHash);
  if (!passwordMatches) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Current password is incorrect.');
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  const updatedAdmin = await prisma.adminUser.update({
    where: { id: input.adminId },
    data: {
      passwordHash,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });

  await revokeAdminSessionsByFilter({
    adminId: input.adminId,
    id: { not: input.sessionId },
  });

  const refreshedSession = {
    ...session,
    admin: updatedAdmin,
    ipAddress: getRequestIp(input.request),
    userAgent: input.request.headers['user-agent'] ?? null,
  };

  await recordAdminAuditLog({
    action: 'ADMIN_PASSWORD_CHANGED',
    actorAdminId: input.adminId,
    targetAdminId: input.adminId,
    entityId: input.adminId,
    entityType: 'AdminUser',
    ipAddress: getRequestIp(input.request),
  });

  return buildLoginResultFromSessionAdmin(refreshedSession, updatedAdmin.tokenVersion);
}
