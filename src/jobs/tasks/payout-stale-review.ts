import type { FastifyBaseLogger } from 'fastify';
import { Prisma, PayoutStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

const ELIGIBLE_STATUSES: PayoutStatus[] = [PayoutStatus.APPROVED, PayoutStatus.PROCESSING];

export const runPayoutStaleReviewJob = async (
  logger: FastifyBaseLogger,
  options: {
    staleHours: number;
  }
) => {
  const staleBefore = new Date(Date.now() - options.staleHours * 60 * 60 * 1000);

  const candidates = await prisma.payoutRequest.findMany({
    where: {
      status: { in: ELIGIBLE_STATUSES },
      updatedAt: { lt: staleBefore }
    },
    select: {
      id: true,
      merchantId: true,
      settlementProfileId: true,
      providerId: true,
      amount: true,
      currency: true,
      status: true,
      updatedAt: true
    },
    take: 100
  });

  let flaggedCount = 0;

  for (const payout of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.payoutRequest.findUnique({
        where: { id: payout.id },
        select: {
          id: true,
          status: true,
          metadata: true,
          reviewedById: true,
          providerPayoutRef: true,
          failureReason: true,
          internalNote: true
        }
      });

      if (!current || !ELIGIBLE_STATUSES.includes(current.status)) {
        return false;
      }

      const metadata = typeof current.metadata === 'object' && current.metadata !== null && !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {};

      await tx.payoutRequest.update({
        where: { id: payout.id },
        data: {
          status: PayoutStatus.MANUAL_REQUIRED,
          internalNote: current.internalNote ?? 'Automatically flagged for manual review by background job',
          metadata: {
            ...metadata,
            staleReviewFlaggedAt: new Date().toISOString(),
            staleReviewReason: 'payout_stale_background_job'
          } as Prisma.InputJsonValue
        }
      });

      await tx.payoutEvent.create({
        data: {
          payoutRequestId: payout.id,
          action: 'AUTO_FLAGGED_MANUAL_REQUIRED',
          fromStatus: current.status,
          toStatus: PayoutStatus.MANUAL_REQUIRED,
          note: 'Automatically flagged for manual review because payout stayed stale beyond threshold',
          metadata: {
            staleHours: options.staleHours,
            previousUpdatedAt: payout.updatedAt.toISOString()
          },
          createdById: null
        }
      });

      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          actorId: null,
          action: 'PAYOUT_AUTO_FLAGGED_MANUAL_REQUIRED',
          entityType: 'PayoutRequest',
          entityId: payout.id,
          metadata: {
            fromStatus: current.status,
            toStatus: PayoutStatus.MANUAL_REQUIRED,
            staleHours: options.staleHours,
            merchantId: payout.merchantId,
            settlementProfileId: payout.settlementProfileId,
            providerId: payout.providerId,
            amount: payout.amount.toString(),
            currency: payout.currency
          }
        }
      });

      return true;
    });

    if (!result) {
      continue;
    }

    flaggedCount += 1;
    logger.warn(
      {
        job: 'payout-stale-review',
        payoutId: payout.id,
        fromStatus: payout.status,
        toStatus: PayoutStatus.MANUAL_REQUIRED
      },
      'Flagged stale payout for manual review'
    );
  }

  return {
    processed: flaggedCount
  };
};
