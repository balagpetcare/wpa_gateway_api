import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Maps HTTP method + response status to a compact action string logged in AuditLog.
const resolveAction = (method: string, path: string, statusCode: number): string => {
  const segment = path.split('/').filter(Boolean).at(-1) ?? 'unknown';
  const verb =
    method === 'POST' ? 'CREATE' :
    method === 'PUT' || method === 'PATCH' ? 'UPDATE' :
    method === 'DELETE' ? 'DELETE' :
    'ACCESS';

  const outcome = statusCode < 400 ? 'SUCCESS' : 'FAILED';
  return `ADMIN_${verb.toUpperCase()}_${segment.toUpperCase().replace(/-/g, '_')}_${outcome}`;
};

/**
 * Fastify onResponse hook.
 * Automatically writes an AuditLog entry for every mutating admin API call.
 * Routes that already write their own detailed audit entry (e.g. merchant create)
 * will produce a second, lighter entry here — that duplication is intentional
 * so that even error paths (like a 500 during a DB write) are recorded.
 */
export const adminAuditHook = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (!WRITE_METHODS.has(request.method)) return;

  const path = new URL(request.url, 'http://localhost').pathname;
  if (!path.startsWith('/admin/')) return;

  // Skip auth endpoints — they have their own logging and don't carry adminUser
  if (path.startsWith('/admin/auth/')) return;

  const adminId = request.adminUser?.id ?? null;
  const action = resolveAction(request.method, path, reply.statusCode);

  try {
    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: adminId,
        action,
        entityType: 'AdminAction',
        entityId: request.id,
        ipAddress: request.ip,
        metadata: {
          method: request.method,
          path,
          statusCode: reply.statusCode
        }
      }
    });
  } catch {
    // Audit failures must never surface as user-visible errors.
    request.log.error({ path, action }, 'Failed to write admin audit log entry');
  }
};
