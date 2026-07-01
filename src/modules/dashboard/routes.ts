import type { FastifyPluginAsync } from 'fastify';
import { Prisma, RefundStatus, TransactionStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';

type StatusCountRow<T extends string> = {
  status: T;
  count: number;
};

type CurrencyVolumeRow = {
  currency: string;
  volume: string;
  transactionCount: number;
};

type DailyVolumeRow = {
  date: string;
  volume: string;
  transactionCount: number;
};

type EntityVolumeRow = {
  id: string;
  name: string;
  volume: string;
  transactionCount: number;
};

const TRANSACTION_STATUS_ORDER = [
  TransactionStatus.PENDING,
  TransactionStatus.SUCCESS,
  TransactionStatus.AUTHORIZED,
  TransactionStatus.CAPTURED,
  TransactionStatus.FAILED,
  TransactionStatus.CANCELLED,
  TransactionStatus.REFUNDED
] as const;

const REFUND_STATUS_ORDER = [
  RefundStatus.PENDING_MANUAL_REVIEW,
  RefundStatus.PROCESSING,
  RefundStatus.SUCCESS,
  RefundStatus.FAILED,
  RefundStatus.CANCELLED
] as const;

const mapCounts = <T extends string>(order: readonly T[], rows: StatusCountRow<T>[]) => {
  const counts = new Map<T, number>(rows.map((row) => [row.status, row.count]));
  return order.map((status) => ({
    status,
    count: counts.get(status) ?? 0
  }));
};

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/dashboard/stats',
    {
      preHandler: [requireAdminAuth, requirePermission('dashboard.read')]
    },
    async () => {
      const successWhere = { status: { in: [TransactionStatus.SUCCESS, TransactionStatus.CAPTURED] } };
      const todayStart = Prisma.sql`date_trunc('day', now())`;
      const todayEnd = Prisma.sql`date_trunc('day', now()) + interval '1 day'`;

      const [
        totalTransactionCount,
        successfulTransactionCount,
        failedTransactionCount,
        pendingTransactionCount,
        refundedTransactionCount,
        activeMerchantCount,
        activeProviderCount,
        transactionStatusRows,
        refundStatusRows,
        volumeByCurrency,
        todayVolumeByCurrency,
        dailyVolumeLast30Days,
        providerWiseTransactionVolume,
        topMerchantsByTransactionVolume
      ] = await Promise.all([
        prisma.transaction.count(),
        prisma.transaction.count({ where: successWhere }),
        prisma.transaction.count({ where: { status: TransactionStatus.FAILED } }),
        prisma.transaction.count({ where: { status: TransactionStatus.PENDING } }),
        prisma.transaction.count({ where: { status: TransactionStatus.REFUNDED } }),
        prisma.merchant.count({ where: { status: 'ACTIVE' } }),
        prisma.paymentProvider.count({ where: { isActive: true } }),
        prisma.transaction.groupBy({
          by: ['status'],
          _count: { _all: true }
        }),
        prisma.refund.groupBy({
          by: ['status'],
          _count: { _all: true }
        }),
        prisma.$queryRaw<CurrencyVolumeRow[]>(Prisma.sql`
          SELECT
            t.currency AS currency,
            COALESCE(SUM(t.amount), 0)::text AS volume,
            COUNT(*)::int AS "transactionCount"
          FROM transactions t
          WHERE t.status IN ('SUCCESS', 'CAPTURED')
          GROUP BY t.currency
          ORDER BY COALESCE(SUM(t.amount), 0) DESC, t.currency ASC
        `),
        prisma.$queryRaw<CurrencyVolumeRow[]>(Prisma.sql`
          SELECT
            t.currency AS currency,
            COALESCE(SUM(t.amount), 0)::text AS volume,
            COUNT(*)::int AS "transactionCount"
          FROM transactions t
          WHERE t.status IN ('SUCCESS', 'CAPTURED')
            AND t.created_at >= ${todayStart}
            AND t.created_at < ${todayEnd}
          GROUP BY t.currency
          ORDER BY COALESCE(SUM(t.amount), 0) DESC, t.currency ASC
        `),
        prisma.$queryRaw<DailyVolumeRow[]>(Prisma.sql`
          SELECT
            to_char(day_bucket, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(t.amount), 0)::text AS volume,
            COUNT(t.id)::int AS "transactionCount"
          FROM generate_series(
            date_trunc('day', now()) - interval '29 days',
            date_trunc('day', now()),
            interval '1 day'
          ) AS day_bucket(day_bucket)
          LEFT JOIN transactions t
            ON t.created_at >= day_bucket
           AND t.created_at < day_bucket + interval '1 day'
           AND t.status IN ('SUCCESS', 'CAPTURED')
          GROUP BY day_bucket
          ORDER BY day_bucket ASC
        `),
        prisma.$queryRaw<EntityVolumeRow[]>(Prisma.sql`
          SELECT
            p.id AS id,
            p.display_name AS name,
            COALESCE(SUM(t.amount), 0)::text AS volume,
            COUNT(*)::int AS "transactionCount"
          FROM transactions t
          JOIN payment_providers p ON p.id = t.provider_id
          WHERE t.status IN ('SUCCESS', 'CAPTURED')
          GROUP BY p.id, p.display_name
          ORDER BY COALESCE(SUM(t.amount), 0) DESC, COUNT(*) DESC, p.display_name ASC
        `),
        prisma.$queryRaw<EntityVolumeRow[]>(Prisma.sql`
          SELECT
            m.id AS id,
            m.name AS name,
            COALESCE(SUM(t.amount), 0)::text AS volume,
            COUNT(*)::int AS "transactionCount"
          FROM transactions t
          JOIN payment_sessions s ON s.id = t.session_id
          JOIN merchants m ON m.id = s.merchant_id
          WHERE t.status IN ('SUCCESS', 'CAPTURED')
          GROUP BY m.id, m.name
          ORDER BY COALESCE(SUM(t.amount), 0) DESC, COUNT(*) DESC, m.name ASC
          LIMIT 10
        `)
      ]);

      const totalSuccessful = successfulTransactionCount;
      const successRate = totalTransactionCount > 0 ? Number(((totalSuccessful / totalTransactionCount) * 100).toFixed(2)) : 0;

      return {
        data: {
          generatedAt: new Date().toISOString(),
          totals: {
            totalTransactionCount,
            successfulTransactionCount,
            failedTransactionCount,
            pendingTransactionCount,
            refundedTransactionCount,
            successRate,
            activeMerchantCount,
            activeProviderCount
          },
          volumeByCurrency,
          todayVolumeByCurrency,
          refundCountByStatus: mapCounts(
            REFUND_STATUS_ORDER,
            refundStatusRows.map((row) => ({
              status: row.status,
              count: row._count._all
            }))
          ),
          dailyVolumeLast30Days,
          transactionCountByStatus: mapCounts(
            TRANSACTION_STATUS_ORDER,
            transactionStatusRows.map((row) => ({
              status: row.status,
              count: row._count._all
            }))
          ),
          providerWiseTransactionVolume,
          topMerchantsByTransactionVolume
        }
      };
    }
  );
};
