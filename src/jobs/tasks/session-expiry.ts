import type { FastifyBaseLogger } from 'fastify';
import { SessionStatus, TransactionStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { createAuditLog } from '../../services/audit.js';

const ACTIVE_TRANSACTION_STATUSES: TransactionStatus[] = [
  TransactionStatus.PENDING,
  TransactionStatus.AUTHORIZED
];

const TERMINAL_PAID_TRANSACTION_STATUSES: TransactionStatus[] = [
  TransactionStatus.SUCCESS,
  TransactionStatus.CAPTURED,
  TransactionStatus.REFUNDED
];

export const runSessionExpiryJob = async (logger: FastifyBaseLogger) => {
  const candidates = await prisma.paymentSession.findMany({
    where: {
      status: SessionStatus.PENDING,
      expiresAt: { lt: new Date() }
    },
    select: {
      id: true,
      reference: true,
      expiresAt: true,
      transactions: {
        select: {
          id: true,
          status: true
        }
      }
    },
    take: 200
  });

  let expiredCount = 0;

  for (const session of candidates) {
    const hasTerminalPaidTransaction = session.transactions.some((transaction) =>
      TERMINAL_PAID_TRANSACTION_STATUSES.includes(transaction.status)
    );
    const hasActiveProviderTransaction = session.transactions.some((transaction) =>
      ACTIVE_TRANSACTION_STATUSES.includes(transaction.status)
    );

    if (hasTerminalPaidTransaction || hasActiveProviderTransaction) {
      logger.info(
        {
          job: 'session-expiry',
          sessionId: session.id,
          reference: session.reference,
          skipped: true
        },
        'Skipped expiring pending session due to transaction state'
      );
      continue;
    }

    const updated = await prisma.paymentSession.updateMany({
      where: {
        id: session.id,
        status: SessionStatus.PENDING
      },
      data: {
        status: SessionStatus.EXPIRED
      }
    });

    if (updated.count === 0) {
      continue;
    }

    expiredCount += 1;

    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'PAYMENT_SESSION_EXPIRED',
      entityType: 'PaymentSession',
      entityId: session.id,
      metadata: {
        reference: session.reference,
        expiredAt: new Date().toISOString(),
        originalExpiresAt: session.expiresAt?.toISOString() ?? null
      }
    });

    logger.info(
      {
        job: 'session-expiry',
        sessionId: session.id,
        reference: session.reference
      },
      'Expired pending payment session'
    );
  }

  return {
    processed: expiredCount
  };
};
