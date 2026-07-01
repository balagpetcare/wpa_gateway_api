import type { FastifyBaseLogger } from 'fastify';
import { DeliveryStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { attemptCallbackDelivery } from '../../services/callback-delivery.js';

export const runCallbackRetryJob = async (
  logger: FastifyBaseLogger,
  options: {
    maxAttempts: number;
    baseDelaySeconds: number;
  }
) => {
  const candidates = await prisma.callbackLog.findMany({
    where: {
      status: { in: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
      attempts: { lt: options.maxAttempts },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }]
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      sessionId: true,
      attempts: true,
      callbackUrl: true,
      status: true
    }
  });

  let retriedCount = 0;

  for (const candidate of candidates) {
    logger.info(
      {
        job: 'callback-retry',
        callbackLogId: candidate.id,
        sessionId: candidate.sessionId,
        attempts: candidate.attempts
      },
      'Retrying callback delivery'
    );

    await attemptCallbackDelivery(candidate.id, {
      baseDelaySeconds: options.baseDelaySeconds,
      maxAttempts: options.maxAttempts
    });

    retriedCount += 1;
  }

  return {
    processed: retriedCount
  };
};
