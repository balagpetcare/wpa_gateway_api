import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

const toJsonValue = (value?: Record<string, unknown>) => {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Prisma.InputJsonObject;
};

export const createAuditLog = async (input: {
  actorType: 'ADMIN' | 'MERCHANT' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}) =>
  prisma.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ipAddress: input.ipAddress ?? null,
      metadata: toJsonValue(input.metadata)
    }
  });
