import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TransactionStatus } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';
import { ApiError } from '../../utils/errors.js';
import { getProviderAdapter } from '../../providers/index.js';
import { getDecryptedCredentialsForSession } from '../../services/provider-credentials.js';
import { redactSensitiveData } from '../../utils/redaction.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.nativeEnum(TransactionStatus).optional(),
  merchantId: z.string().optional(),
  providerId: z.string().optional(),
  currency: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sortBy: z.enum(['createdAt', 'amount', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// Roles that are not SUPER_ADMIN or ADMIN must supply a merchantId filter
const RESTRICTED_ROLES = new Set(['VIEWER']);

export const transactionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/transactions',
    {
      preHandler: [requireAdminAuth, requirePermission('transactions:read')],
      preValidation: validateQuery(listQuerySchema)
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof listQuerySchema>;
      const role = request.adminUser!.role;

      // Restricted roles must provide a merchantId filter to avoid returning all data
      if (RESTRICTED_ROLES.has(role) && !q.merchantId) {
        throw new ApiError(400, 'MERCHANT_FILTER_REQUIRED', 'Your role requires a merchantId filter to query transactions.');
      }

      // Build Prisma WHERE clause
      const where: Record<string, unknown> = {};

      // Session-level filters applied via nested relation
      if (q.merchantId) {
        where.session = { merchantId: q.merchantId };
      }

      if (q.status) where.status = q.status;
      if (q.providerId) where.providerId = q.providerId;
      if (q.currency) where.currency = q.currency.toUpperCase();

      // Date range on createdAt
      if (q.dateFrom || q.dateTo) {
        const dateFilter: Record<string, Date> = {};
        if (q.dateFrom) dateFilter.gte = new Date(q.dateFrom);
        if (q.dateTo) {
          const to = new Date(q.dateTo);
          to.setHours(23, 59, 59, 999);
          dateFilter.lte = to;
        }
        where.createdAt = dateFilter;
      }

      // Full-text search across providerReference, currency, session reference, and orderId.
      // When a merchantId session filter is already set, search adds OR conditions that still
      // satisfy the top-level session filter via AND semantics in Prisma.
      if (q.search) {
        const t = q.search.trim();
        where.OR = [
          { providerReference: { contains: t, mode: 'insensitive' } },
          { currency: { contains: t.toUpperCase() } },
          { session: { reference: { contains: t, mode: 'insensitive' } } },
          { session: { orderId: { contains: t, mode: 'insensitive' } } }
        ];
      }

      const skip = (q.page - 1) * q.limit;

      const [rows, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { [q.sortBy]: q.sortOrder },
          skip,
          take: q.limit,
          include: {
            session: {
              select: {
                reference: true,
                orderId: true,
                merchantId: true,
                purpose: true,
                environment: true,
                merchant: { select: { id: true, name: true } }
              }
            },
            provider: { select: { id: true, name: true, displayName: true } }
          }
        }),
        prisma.transaction.count({ where })
      ]);

      // Serialize BigInt amount to string to preserve precision in JSON
      const data = rows.map((t) => ({
        ...t,
        amount: t.amount.toString(),
        rawResponse: redactSensitiveData(t.rawResponse)
      }));

      return {
        data,
        pagination: {
          total,
          page: q.page,
          limit: q.limit,
          pages: Math.ceil(total / q.limit)
        }
      };
    }
  );

  // POST /admin/transactions/:id/refund
  // Creates a refund for a successfully completed transaction.
  // If the provider adapter implements refundPayment, it is called immediately.
  // If the adapter throws 501 (not implemented), the refund is queued as
  // PENDING_MANUAL_REVIEW rather than returning a fake success.
  app.post(
    '/admin/transactions/:id/refund',
    {
      preHandler: [requireAdminAuth, requirePermission('refunds:write')],
      preValidation: [
        validateParams(z.object({ id: z.string().min(1) })),
        validateBody(
          z.object({
            amount: z.coerce.number().int().positive().optional(),
            reason: z.string().min(1).max(500).optional()
          })
        )
      ]
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { amount: bodyAmount, reason } = request.body as { amount?: number; reason?: string };

      // 1. Load transaction with session and provider
      const txn = await prisma.transaction.findUnique({
        where: { id },
        include: {
          session: {
            select: {
              id: true,
              merchantId: true,
              credentialProfileId: true,
              environment: true
            }
          },
          provider: { select: { id: true, name: true, displayName: true } }
        }
      });

      if (!txn) throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');

      // 2. Only refund terminal-success statuses
      if (txn.status !== TransactionStatus.SUCCESS && txn.status !== TransactionStatus.CAPTURED) {
        throw new ApiError(
          422,
          'INVALID_TRANSACTION_STATE',
          `Transaction status is "${txn.status}". Only SUCCESS or CAPTURED transactions can be refunded.`
        );
      }

      // 3. Prevent duplicate active refunds
      const existingRefund = await prisma.refund.findFirst({
        where: {
          transactionId: id,
          status: { in: ['PENDING_MANUAL_REVIEW', 'PROCESSING', 'SUCCESS'] }
        },
        select: { id: true, status: true }
      });

      if (existingRefund) {
        if (existingRefund.status === 'SUCCESS') {
          throw new ApiError(409, 'ALREADY_REFUNDED', 'This transaction has already been fully refunded.');
        }
        throw new ApiError(
          409,
          'REFUND_IN_PROGRESS',
          `A refund (${existingRefund.id}) for this transaction is already ${existingRefund.status}.`
        );
      }

      // 4. Resolve refund amount — default to full transaction amount
      const refundAmount = bodyAmount !== undefined ? BigInt(bodyAmount) : txn.amount;
      if (refundAmount <= 0n || refundAmount > txn.amount) {
        throw new ApiError(
          422,
          'INVALID_REFUND_AMOUNT',
          `Refund amount must be between 1 and ${txn.amount.toString()} (the original transaction amount).`
        );
      }

      // 5. Decrypt credentials
      const credentials = await getDecryptedCredentialsForSession({
        providerId: txn.providerId,
        merchantId: txn.session.merchantId,
        credentialProfileId: txn.session.credentialProfileId
      }).catch(() => ({}));

      // 6. Attempt provider refund — capture result without throwing
      const adapter = getProviderAdapter(txn.provider);
      let refundStatus: 'PENDING_MANUAL_REVIEW' | 'PROCESSING' | 'SUCCESS' | 'FAILED' = 'PENDING_MANUAL_REVIEW';
      let providerRefundRef: string | null = null;
      let rawResponse: Prisma.InputJsonValue = {};
      let providerSupported = false;

      try {
        const result = await adapter.refundPayment({
          providerReference: txn.providerReference ?? '',
          amount: Number(refundAmount),
          reason,
          credentials
        });

        providerSupported = true;
        providerRefundRef = result.refundReference;
        rawResponse = result.rawResponse as Prisma.InputJsonValue;

        if (result.status === 'SUCCESS') {
          refundStatus = 'SUCCESS';
        } else if (result.status === 'PENDING') {
          refundStatus = 'PROCESSING';
        } else {
          refundStatus = 'FAILED';
        }
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 501) {
          // Provider has not implemented automated refunds — queue for manual processing
          providerSupported = false;
          refundStatus = 'PENDING_MANUAL_REVIEW';
          rawResponse = { reason: 'provider_refund_not_implemented', message: err.message };
        } else {
          // Provider call failed (network error, rejected by provider API, etc.)
          providerSupported = true;
          refundStatus = 'FAILED';
          rawResponse = {
            reason: 'provider_call_failed',
            message: err instanceof Error ? err.message : 'Unknown error'
          };
        }
      }

      // 7. Persist refund record in a transaction so status update is atomic
      const refund = await prisma.$transaction(async (tx) => {
        const created = await tx.refund.create({
          data: {
            transactionId: id,
            sessionId: txn.sessionId,
            merchantId: txn.session.merchantId,
            providerId: txn.providerId,
            amount: refundAmount,
            currency: txn.currency,
            reason: reason ?? null,
            status: refundStatus,
            providerRefundRef,
            rawResponse,
            requestedById: request.adminUser?.id ?? null,
            providerSupported
          }
        });

        // Mark original transaction as REFUNDED only on confirmed provider success
        if (refundStatus === 'SUCCESS') {
          await tx.transaction.update({
            where: { id },
            data: { status: 'REFUNDED' }
          });
        }

        return created;
      });

      // 8. Audit log
      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'REFUND_REQUESTED',
          entityType: 'Refund',
          entityId: refund.id,
          ipAddress: request.ip,
          metadata: {
            transactionId: id,
            merchantId: txn.session.merchantId,
            providerId: txn.providerId,
            refundAmount: refundAmount.toString(),
            currency: txn.currency,
            refundStatus,
            providerSupported,
            reason: reason ?? null
          }
        }
      });

      return reply.status(201).send({
        data: {
          ...refund,
          amount: refund.amount.toString()
        }
      });
    }
  );
};
