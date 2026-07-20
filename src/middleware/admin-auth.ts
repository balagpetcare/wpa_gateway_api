import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { AdminRole } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

type JwtAdminPayload = {
  sub: string;
  email: string;
  role: string;
};

// Global Super Admin, Stage 1. Dedicated admin audience — distinct from
// any mobile/end-user audience — verified with a secret shared with WPA
// Central Auth (CENTRAL_AUTH_JWT_SECRET), completely independent of this
// gateway's own local admin JWT_SECRET/@fastify/jwt session stack.
const CENTRAL_AUTH_ADMIN_AUDIENCE = 'wpa-gateway-admin';
const GLOBAL_SUPER_ADMIN_ROLE = 'GLOBAL_SUPER_ADMIN';
const WPA_SERVICE_PERMISSION = 'wpa:*';

type CentralAuthAdminClaims = {
  sub: string;
  email?: string;
  roles?: string[];
  perms?: string[];
};

/**
 * Payments admin surface — highest blast radius of the Stage 1 rollout, so
 * this stays strictly additive: the existing local @fastify/jwt admin
 * session path (below) is tried first and is completely unchanged. Only if
 * that fails is a Central Auth token considered, and only when it is
 * signed with the shared Central Auth secret, carries the dedicated
 * "wpa-gateway-admin" audience, and has both GLOBAL_SUPER_ADMIN and wpa:*.
 */
export const requireAdminAuth = async (request: FastifyRequest, reply: FastifyReply) => {
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
    return;
  } catch (localError) {
    if (localError instanceof ApiError) {
      // A well-formed local token that failed a real business check (e.g.
      // inactive account) should not silently fall through to a different
      // auth mechanism.
      throw localError;
    }
    // Local @fastify/jwt verification itself failed (missing/invalid/
    // wrong-secret token) — fall through and try Central Auth below.
  }

  await requireCentralAuthAdmin(request, reply);
};

async function requireCentralAuthAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!env.CENTRAL_AUTH_JWT_SECRET || !env.CENTRAL_AUTH_ISSUER) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }
  const token = authHeader.slice(7);

  let claims: CentralAuthAdminClaims;
  try {
    claims = jwt.verify(token, env.CENTRAL_AUTH_JWT_SECRET, {
      issuer: env.CENTRAL_AUTH_ISSUER,
      audience: CENTRAL_AUTH_ADMIN_AUDIENCE
    }) as CentralAuthAdminClaims;
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  const roles = claims.roles ?? [];
  const perms = claims.perms ?? [];
  if (!roles.includes(GLOBAL_SUPER_ADMIN_ROLE) || !perms.includes(WPA_SERVICE_PERMISSION)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }
  if (!claims.email) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
  }

  const admin = await ensureCentralAuthAdminUser(claims.sub, claims.email);
  request.adminUser = { id: admin.id, email: admin.email, role: admin.role };
}

async function ensureCentralAuthAdminUser(centralUserId: string, email: string) {
  const byCentralId = await prisma.adminUser.findUnique({ where: { centralUserId } });
  if (byCentralId) {
    if (!byCentralId.isActive) {
      // Central Auth is the source of truth for account status; a stale
      // local mirror must never permanently lock out an active central
      // admin.
      return prisma.adminUser.update({ where: { id: byCentralId.id }, data: { isActive: true } });
    }
    return byCentralId;
  }

  const byEmail = await prisma.adminUser.findUnique({ where: { email } });
  if (byEmail) {
    if (byEmail.centralUserId && byEmail.centralUserId !== centralUserId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
    }
    if (!byEmail.centralUserId) {
      // A local gateway admin account already exists for this email and is
      // not linked to Central Auth — refuse to auto-link an unrelated
      // account rather than silently taking it over.
      throw new ApiError(401, 'UNAUTHORIZED', 'Admin authentication failed');
    }
    return byEmail;
  }

  // Random, immediately-discarded placeholder: `password_hash` is NOT NULL
  // on this legacy table. This satisfies that constraint without creating
  // a usable local credential — nobody knows the plaintext and it is never
  // logged, returned, or reused. Central Auth remains the sole source of
  // truth for this account's real password.
  const unusablePasswordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);

  return prisma.adminUser.create({
    data: {
      email,
      centralUserId,
      passwordHash: unusablePasswordHash,
      role: AdminRole.SUPER_ADMIN,
      isActive: true
    }
  });
}
