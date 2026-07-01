import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __wpaPrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__wpaPrisma ??
  new PrismaClient({
    log: ['warn', 'error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__wpaPrisma = prisma;
}
