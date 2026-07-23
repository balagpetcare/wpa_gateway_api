import type { FastifyPluginAsync } from 'fastify';
import { CredentialScope, Prisma, PayoutMethod, PayoutStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';

const bigIntLikeSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => value.toString())
  .refine((value) => /^\d+$/.test(value), 'Amount must be a positive whole number');

const payoutMetadataSchema = z.record(z.string(), z.unknown()).optional().nullable();

const payoutCreateSchema = z.object({
  merchantId: z.string().min(1),
  settlementProfileId: z.string().min(1),
  providerId: z.string().min(1).nullable().optional(),
  amount: bigIntLikeSchema,
  currency: z.string().min(3).max(3),
  countryCode: z.string().min(2).max(3),
  method: z.nativeEnum(PayoutMethod).optional(),
  internalNote: z.string().max(2000).nullable().optional(),
  metadata: payoutMetadataSchema
});

const payoutUpdateSchema = z.object({
  settlementProfileId: z.string().min(1).optional(),
  providerId: z.string().min(1).nullable().optional(),
  amount: bigIntLikeSchema.optional(),
  currency: z.string().min(3).max(3).optional(),
  countryCode: z.string().min(2).max(3).optional(),
  method: z.nativeEnum(PayoutMethod).optional(),
  internalNote: z.string().max(2000).nullable().optional(),
  metadata: payoutMetadataSchema,
  failureReason: z.string().max(2000).nullable().optional(),
  providerPayoutRef: z.string().max(255).nullable().optional()
});

const payoutListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  merchantId: z.string().optional(),
  providerId: z.string().optional(),
  status: z.nativeEnum(PayoutStatus).optional(),
  currency: z.string().optional(),
  countryCode: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional()
});

const payoutIdSchema = z.object({
  id: z.string().min(1)
});

const payoutActionBodySchema = z.object({
  note: z.string().max(2000).nullable().optional(),
  internalNote: z.string().max(2000).nullable().optional(),
  failureReason: z.string().max(2000).nullable().optional(),
  providerPayoutRef: z.string().max(255).nullable().optional(),
  metadata: payoutMetadataSchema
});

const RESTRICTED_ROLES = new Set(['VIEWER']);
const RESERVE_STATUSES: PayoutStatus[] = [
  PayoutStatus.PENDING_REVIEW,
  PayoutStatus.APPROVED,
  PayoutStatus.PROCESSING,
  PayoutStatus.SUCCESS,
  PayoutStatus.MANUAL_REQUIRED
];

type PayoutCreatePayload = z.infer<typeof payoutCreateSchema>;
type PayoutUpdatePayload = z.infer<typeof payoutUpdateSchema>;
type PayoutActionBody = z.infer<typeof payoutActionBodySchema>;

type BalanceRow = {
  merchantId: string;
  currency: string;
  grossAmount: string;
};

type RefundBalanceRow = {
  merchantId: string;
  currency: string;
  refundedAmount: string;
};

type ReservedPayoutRow = {
  merchantId: string;
  currency: string;
  reservedAmount: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const uppercaseOrNull = (value: string | null | undefined) => {
  if (value === null || value === undefined || value === '') return null;
  return value.toUpperCase();
};

const maskAccountNumber = (value: unknown) => {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 4) return `**${value}`;
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
};

const normalizeNote = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toJsonInput = (value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined => {
  if (!value) return undefined;
  return value as Prisma.InputJsonValue;
};

const requireMerchantFilterForRestrictedRole = (role: string, merchantId?: string | null) => {
  if (RESTRICTED_ROLES.has(role) && !merchantId) {
    throw new ApiError(400, 'MERCHANT_FILTER_REQUIRED', 'Your role requires a merchantId filter to query payout data.');
  }
};

const ensurePayoutSuccessRole = (role: string) => {
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    throw new ApiError(403, 'FORBIDDEN', 'Only ADMIN or SUPER_ADMIN can manually mark a payout as SUCCESS.');
  }
};

const getSettlementMetadata = (profile: { metadata: Prisma.JsonValue }) => {
  const metadata = isRecord(profile.metadata) ? profile.metadata : {};
  return {
    merchantId: typeof metadata.merchantId === 'string' ? metadata.merchantId : null,
    providerId: typeof metadata.providerId === 'string' ? metadata.providerId : null,
    settlementType: typeof metadata.settlementType === 'string' ? metadata.settlementType : 'BANK_ACCOUNT',
    minimumAmount:
      typeof metadata.minimumAmount === 'string'
        ? metadata.minimumAmount
        : typeof metadata.minimumAmount === 'number' || typeof metadata.minimumAmount === 'bigint'
          ? String(metadata.minimumAmount)
          : null,
    bankDetails: isRecord(metadata.bankDetails) ? metadata.bankDetails : null,
    mobileWalletDetails: isRecord(metadata.mobileWalletDetails) ? metadata.mobileWalletDetails : null,
    accountDetails: isRecord(metadata.accountDetails) ? metadata.accountDetails : null
  };
};

const derivePayoutMethod = (settlementType: string, explicit?: PayoutMethod | null) => {
  if (explicit) return explicit;
  if (settlementType === 'BANK_ACCOUNT') return PayoutMethod.BANK_TRANSFER;
  if (settlementType === 'MOBILE_WALLET') return PayoutMethod.MOBILE_WALLET;
  return PayoutMethod.OTHER;
};

const buildMaskedDestination = (profile: {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  metadata: Prisma.JsonValue;
}) => {
  const metadata = getSettlementMetadata(profile);

  return {
    settlementProfileId: profile.id,
    settlementProfileName: profile.name,
    settlementType: metadata.settlementType,
    countryCode: profile.countryCode,
    currencyCode: profile.currencyCode,
    bankDetails: metadata.bankDetails
      ? {
          bankName: typeof metadata.bankDetails.bankName === 'string' ? metadata.bankDetails.bankName : null,
          accountName: typeof metadata.bankDetails.accountName === 'string' ? metadata.bankDetails.accountName : null,
          accountNumberMasked: maskAccountNumber(metadata.bankDetails.accountNumber),
          routingNumberMasked: maskAccountNumber(metadata.bankDetails.routingNumber),
          swiftCode: typeof metadata.bankDetails.swiftCode === 'string' ? metadata.bankDetails.swiftCode : null,
          ibanMasked: maskAccountNumber(metadata.bankDetails.iban),
          branchName: typeof metadata.bankDetails.branchName === 'string' ? metadata.bankDetails.branchName : null
        }
      : null,
    mobileWalletDetails: metadata.mobileWalletDetails
      ? {
          providerName: typeof metadata.mobileWalletDetails.providerName === 'string' ? metadata.mobileWalletDetails.providerName : null,
          walletIdMasked: maskAccountNumber(metadata.mobileWalletDetails.walletId),
          accountName: typeof metadata.mobileWalletDetails.accountName === 'string' ? metadata.mobileWalletDetails.accountName : null,
          mobileNumberMasked: maskAccountNumber(metadata.mobileWalletDetails.mobileNumber)
        }
      : null,
    accountDetails: metadata.accountDetails
      ? {
          accountName: typeof metadata.accountDetails.accountName === 'string' ? metadata.accountDetails.accountName : null,
          accountNumberMasked: maskAccountNumber(metadata.accountDetails.accountNumber),
          accountType: typeof metadata.accountDetails.accountType === 'string' ? metadata.accountDetails.accountType : null,
          branchName: typeof metadata.accountDetails.branchName === 'string' ? metadata.accountDetails.branchName : null
        }
      : null
  };
};

const computeAvailableBalance = async (input: {
  merchantId: string;
  currency: string;
  excludePayoutId?: string;
}) => {
  const currency = input.currency.toUpperCase();

  const [grossRow, refundRow, reservedRow] = await Promise.all([
    prisma.$queryRaw<{ grossAmount: string }[]>(Prisma.sql`
      SELECT COALESCE(SUM(t.amount), 0)::text AS "grossAmount"
      FROM transactions t
      JOIN payment_sessions s ON s.id = t.session_id
      WHERE s.merchant_id = ${input.merchantId}
        AND t.currency = ${currency}
        AND t.status IN ('SUCCESS', 'CAPTURED')
    `),
    prisma.$queryRaw<{ refundedAmount: string }[]>(Prisma.sql`
      SELECT COALESCE(SUM(r.amount), 0)::text AS "refundedAmount"
      FROM refunds r
      WHERE r.merchant_id = ${input.merchantId}
        AND r.currency = ${currency}
        AND r.status = 'SUCCESS'
    `),
    prisma.$queryRaw<{ reservedAmount: string }[]>(Prisma.sql`
      SELECT COALESCE(SUM(p.amount), 0)::text AS "reservedAmount"
      FROM payout_requests p
      WHERE p.merchant_id = ${input.merchantId}
        AND p.currency = ${currency}
        AND p.status IN (${Prisma.join(RESERVE_STATUSES)})
        AND (${input.excludePayoutId ?? null}::text IS NULL OR p.id <> ${input.excludePayoutId ?? null})
    `)
  ]);

  const grossAmount = BigInt(grossRow[0]?.grossAmount ?? '0');
  const refundedAmount = BigInt(refundRow[0]?.refundedAmount ?? '0');
  const reservedAmount = BigInt(reservedRow[0]?.reservedAmount ?? '0');
  const availableAmount = grossAmount - refundedAmount - reservedAmount;

  return {
    grossAmount,
    refundedAmount,
    reservedAmount,
    availableAmount
  };
};

const computeBalanceMap = async (filters: {
  merchantId?: string;
  providerId?: string;
  currency?: string;
}) => {
  const currency = uppercaseOrNull(filters.currency);
  const [grossRows, refundRows, reservedRows] = await Promise.all([
    prisma.$queryRaw<BalanceRow[]>(Prisma.sql`
      SELECT
        m.id AS "merchantId",
        t.currency AS currency,
        COALESCE(SUM(t.amount), 0)::text AS "grossAmount"
      FROM transactions t
      JOIN payment_sessions s ON s.id = t.session_id
      JOIN merchants m ON m.id = s.merchant_id
      JOIN payment_providers p ON p.id = t.provider_id
      WHERE t.status IN ('SUCCESS', 'CAPTURED')
        AND (${filters.merchantId ?? null}::text IS NULL OR m.id = ${filters.merchantId ?? null})
        AND (${filters.providerId ?? null}::text IS NULL OR p.id = ${filters.providerId ?? null})
        AND (${currency}::text IS NULL OR t.currency = ${currency})
      GROUP BY m.id, t.currency
    `),
    prisma.$queryRaw<RefundBalanceRow[]>(Prisma.sql`
      SELECT
        r.merchant_id AS "merchantId",
        r.currency AS currency,
        COALESCE(SUM(r.amount), 0)::text AS "refundedAmount"
      FROM refunds r
      JOIN payment_providers p ON p.id = r.provider_id
      WHERE r.status = 'SUCCESS'
        AND (${filters.merchantId ?? null}::text IS NULL OR r.merchant_id = ${filters.merchantId ?? null})
        AND (${filters.providerId ?? null}::text IS NULL OR p.id = ${filters.providerId ?? null})
        AND (${currency}::text IS NULL OR r.currency = ${currency})
      GROUP BY r.merchant_id, r.currency
    `),
    prisma.$queryRaw<ReservedPayoutRow[]>(Prisma.sql`
      SELECT
        p.merchant_id AS "merchantId",
        p.currency AS currency,
        COALESCE(SUM(p.amount), 0)::text AS "reservedAmount"
      FROM payout_requests p
      WHERE p.status IN (${Prisma.join(RESERVE_STATUSES)})
        AND (${filters.merchantId ?? null}::text IS NULL OR p.merchant_id = ${filters.merchantId ?? null})
        AND (${filters.providerId ?? null}::text IS NULL OR p.provider_id = ${filters.providerId ?? null})
        AND (${currency}::text IS NULL OR p.currency = ${currency})
      GROUP BY p.merchant_id, p.currency
    `)
  ]);

  const map = new Map<string, string>();
  const keys = new Set<string>();

  for (const row of grossRows) keys.add(`${row.merchantId}:${row.currency}`);
  for (const row of refundRows) keys.add(`${row.merchantId}:${row.currency}`);
  for (const row of reservedRows) keys.add(`${row.merchantId}:${row.currency}`);

  for (const key of keys) {
    const [merchantId, rowCurrency] = key.split(':');
    const gross = BigInt(grossRows.find((row) => row.merchantId === merchantId && row.currency === rowCurrency)?.grossAmount ?? '0');
    const refunded = BigInt(refundRows.find((row) => row.merchantId === merchantId && row.currency === rowCurrency)?.refundedAmount ?? '0');
    const reserved = BigInt(reservedRows.find((row) => row.merchantId === merchantId && row.currency === rowCurrency)?.reservedAmount ?? '0');
    map.set(key, (gross - refunded - reserved).toString());
  }

  return map;
};

const getDestinationSnapshot = (profile: {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  metadata: Prisma.JsonValue;
}) => buildMaskedDestination(profile);

const sanitizePayout = (
  payout: any,
  availableBalance?: string
) => ({
  id: payout.id,
  merchantId: payout.merchantId,
  settlementProfileId: payout.settlementProfileId,
  providerId: payout.providerId,
  amount: payout.amount.toString(),
  currency: payout.currency,
  countryCode: payout.countryCode,
  method: payout.method,
  status: payout.status,
  requestedById: payout.requestedById,
  reviewedById: payout.reviewedById,
  approvedAt: payout.approvedAt,
  processedAt: payout.processedAt,
  providerPayoutRef: payout.providerPayoutRef,
  failureReason: payout.failureReason,
  internalNote: payout.internalNote,
  metadata: isRecord(payout.metadata) ? payout.metadata : {},
  createdAt: payout.createdAt,
  updatedAt: payout.updatedAt,
  availableComputedBalance: availableBalance ?? null,
  merchant: payout.merchant
    ? {
        id: payout.merchant.id,
        name: payout.merchant.name,
        businessName: payout.merchant.businessName
      }
    : null,
  provider: payout.provider
    ? {
        id: payout.provider.id,
        name: payout.provider.name,
        displayName: payout.provider.displayName
      }
    : null,
  settlementProfile: payout.settlementProfile
    ? {
        id: payout.settlementProfile.id,
        name: payout.settlementProfile.name,
        countryCode: payout.settlementProfile.countryCode,
        currencyCode: payout.settlementProfile.currencyCode,
        isActive: payout.settlementProfile.isActive,
        destination: buildMaskedDestination(payout.settlementProfile)
      }
    : null,
  requestedBy: payout.requestedBy
    ? {
        id: payout.requestedBy.id,
        email: payout.requestedBy.email,
        role: payout.requestedBy.role
      }
    : null,
  reviewedBy: payout.reviewedBy
    ? {
        id: payout.reviewedBy.id,
        email: payout.reviewedBy.email,
        role: payout.reviewedBy.role
      }
    : null,
  events: Array.isArray(payout.events)
    ? payout.events.map((event: any) => ({
        id: event.id,
        action: event.action,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        note: event.note,
        metadata: isRecord(event.metadata) ? event.metadata : {},
        createdAt: event.createdAt,
        createdBy: event.createdBy
          ? {
              id: event.createdBy.id,
              email: event.createdBy.email,
              role: event.createdBy.role
            }
          : null
      }))
    : []
});

const loadSettlementProfileForPayout = async (settlementProfileId: string, merchantId: string) => {
  const profile = await prisma.settlementProfile.findUnique({
    where: { id: settlementProfileId }
  });

  if (!profile) {
    throw new ApiError(404, 'NOT_FOUND', 'Settlement profile not found');
  }

  if (!profile.isActive) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Settlement profile must be active');
  }

  const metadata = getSettlementMetadata(profile);
  if (profile.scopeType !== CredentialScope.MERCHANT || profile.scopeId !== merchantId || metadata.merchantId !== merchantId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Settlement profile must belong to the same merchant');
  }

  return { profile, metadata };
};

const validateCreateOrUpdatePayload = async (payload: {
  merchantId: string;
  settlementProfileId: string;
  providerId?: string | null;
  amount: string;
  currency: string;
  countryCode: string;
  method?: PayoutMethod;
}, options?: { excludePayoutId?: string }) => {
  const amount = BigInt(payload.amount);
  if (amount <= 0n) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payout amount must be greater than zero');
  }

  const merchant = await prisma.merchant.findUnique({
    where: { id: payload.merchantId },
    select: { id: true, name: true, businessName: true, status: true }
  });

  if (!merchant) {
    throw new ApiError(404, 'NOT_FOUND', 'Merchant not found');
  }

  const { profile, metadata } = await loadSettlementProfileForPayout(payload.settlementProfileId, payload.merchantId);

  if (uppercaseOrNull(payload.currency) !== profile.currencyCode) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payout currency must match settlement profile currency');
  }

  if (uppercaseOrNull(payload.countryCode) !== profile.countryCode) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payout country must match settlement profile country');
  }

  const resolvedProviderId = payload.providerId ?? metadata.providerId ?? null;
  if (payload.providerId && metadata.providerId && payload.providerId !== metadata.providerId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payout provider must match the settlement profile provider');
  }

  let provider:
    | {
        id: string;
        name: string;
        displayName: string;
      }
    | null = null;
  if (resolvedProviderId) {
    provider = await prisma.paymentProvider.findUnique({
      where: { id: resolvedProviderId },
      select: { id: true, name: true, displayName: true }
    });

    if (!provider) {
      throw new ApiError(404, 'NOT_FOUND', 'Provider not found');
    }
  }

  const balance = await computeAvailableBalance({
    merchantId: payload.merchantId,
    currency: payload.currency,
    excludePayoutId: options?.excludePayoutId
  });

  if (amount > balance.availableAmount) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Payout amount exceeds computed unsettled balance. Available: ${balance.availableAmount.toString()} ${profile.currencyCode}`
    );
  }

  return {
    merchant,
    profile,
    metadata,
    provider,
    resolvedProviderId,
    method: derivePayoutMethod(metadata.settlementType, payload.method),
    amount,
    availableBalance: balance.availableAmount,
    destinationSnapshot: getDestinationSnapshot(profile)
  };
};

const assertTransition = (currentStatus: PayoutStatus, allowed: PayoutStatus[], action: string) => {
  if (!allowed.includes(currentStatus)) {
    throw new ApiError(409, 'CONFLICT', `Cannot ${action} when payout status is ${currentStatus}.`);
  }
};

const transitionPayout = async (input: {
  payoutId: string;
  action: string;
  toStatus: PayoutStatus;
  adminId: string | null;
  ipAddress?: string | null;
  note?: string | null;
  internalNote?: string | null;
  failureReason?: string | null;
  providerPayoutRef?: string | null;
  metadata?: Record<string, unknown> | null;
  setApprovedAt?: boolean;
  setProcessedAt?: boolean;
}) => {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.payoutRequest.findUnique({
      where: { id: input.payoutId },
      include: {
        merchant: { select: { id: true, name: true, businessName: true } },
        provider: { select: { id: true, name: true, displayName: true } },
        settlementProfile: true,
        requestedBy: { select: { id: true, email: true, role: true } },
        reviewedBy: { select: { id: true, email: true, role: true } },
        events: {
          orderBy: { createdAt: 'asc' },
          include: {
            createdBy: { select: { id: true, email: true, role: true } }
          }
        }
      }
    });

    if (!existing) {
      throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
    }

    const updatedPayout = await tx.payoutRequest.update({
      where: { id: input.payoutId },
      data: {
        status: input.toStatus,
        reviewedById: input.adminId ?? existing.reviewedById,
        approvedAt: input.setApprovedAt ? new Date() : existing.approvedAt,
        processedAt: input.setProcessedAt ? new Date() : existing.processedAt,
        internalNote: input.internalNote !== undefined ? input.internalNote : existing.internalNote,
        failureReason: input.failureReason !== undefined ? input.failureReason : existing.failureReason,
        providerPayoutRef: input.providerPayoutRef !== undefined ? input.providerPayoutRef : existing.providerPayoutRef,
        ...(input.metadata !== undefined && input.metadata !== null
          ? {
              metadata: {
                ...(isRecord(existing.metadata) ? existing.metadata : {}),
                ...input.metadata
              } as Prisma.InputJsonValue
            }
          : {})
      },
      include: {
        merchant: { select: { id: true, name: true, businessName: true } },
        provider: { select: { id: true, name: true, displayName: true } },
        settlementProfile: true,
        requestedBy: { select: { id: true, email: true, role: true } },
        reviewedBy: { select: { id: true, email: true, role: true } },
        events: {
          orderBy: { createdAt: 'asc' },
          include: {
            createdBy: { select: { id: true, email: true, role: true } }
          }
        }
      }
    });

    await tx.payoutEvent.create({
      data: {
        payoutRequestId: input.payoutId,
        action: input.action,
        fromStatus: existing.status,
        toStatus: input.toStatus,
        note: input.note ?? input.internalNote ?? input.failureReason ?? null,
        metadata: toJsonInput(input.metadata),
        createdById: input.adminId
      }
    });

    await tx.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: input.adminId,
        action: `PAYOUT_${input.action}`,
        entityType: 'PayoutRequest',
        entityId: input.payoutId,
        ipAddress: input.ipAddress ?? null,
        metadata: {
          fromStatus: existing.status,
          toStatus: input.toStatus,
          providerPayoutRef: input.providerPayoutRef ?? existing.providerPayoutRef ?? null,
          failureReason: input.failureReason ?? existing.failureReason ?? null,
          merchantId: existing.merchantId,
          settlementProfileId: existing.settlementProfileId,
          providerId: existing.providerId,
          amount: existing.amount.toString(),
          currency: existing.currency
        }
      }
    });

    return updatedPayout.id;
  });

  const updated = await prisma.payoutRequest.findUnique({
    where: { id: input.payoutId },
    include: {
      merchant: { select: { id: true, name: true, businessName: true } },
      provider: { select: { id: true, name: true, displayName: true } },
      settlementProfile: true,
      requestedBy: { select: { id: true, email: true, role: true } },
      reviewedBy: { select: { id: true, email: true, role: true } },
      events: {
        orderBy: { createdAt: 'asc' },
        include: {
          createdBy: { select: { id: true, email: true, role: true } }
        }
      }
    }
  });

  if (!updated) {
    throw new ApiError(404, 'NOT_FOUND', 'Payout request not found after update');
  }

  const balance = await computeAvailableBalance({
    merchantId: updated.merchantId,
    currency: updated.currency,
    excludePayoutId: updated.id
  });

  return sanitizePayout(updated, balance.availableAmount.toString());
};

export const payoutRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/payouts',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:read')],
      preValidation: validateQuery(payoutListQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof payoutListQuerySchema>;
      requireMerchantFilterForRestrictedRole(request.adminUser!.role, q.merchantId);

      const where: Prisma.PayoutRequestWhereInput = {};
      if (q.merchantId) where.merchantId = q.merchantId;
      if (q.providerId) where.providerId = q.providerId;
      if (q.status) where.status = q.status;
      if (q.currency) where.currency = q.currency.toUpperCase();
      if (q.countryCode) where.countryCode = q.countryCode.toUpperCase();
      if (q.dateFrom || q.dateTo) {
        const createdAt: Prisma.DateTimeFilter = {};
        if (q.dateFrom) createdAt.gte = new Date(q.dateFrom);
        if (q.dateTo) {
          const dateTo = new Date(q.dateTo);
          dateTo.setHours(23, 59, 59, 999);
          createdAt.lte = dateTo;
        }
        where.createdAt = createdAt;
      }
      if (q.search) {
        const search = q.search.trim();
        where.OR = [
          { id: { contains: search, mode: 'insensitive' } },
          { merchant: { name: { contains: search, mode: 'insensitive' } } },
          { merchant: { businessName: { contains: search, mode: 'insensitive' } } },
          { settlementProfile: { name: { contains: search, mode: 'insensitive' } } },
          { providerPayoutRef: { contains: search, mode: 'insensitive' } },
          { internalNote: { contains: search, mode: 'insensitive' } },
          { failureReason: { contains: search, mode: 'insensitive' } }
        ];
      }

      const skip = (q.page - 1) * q.limit;
      const [rows, total, balanceMap] = await Promise.all([
        prisma.payoutRequest.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: q.limit,
          include: {
            merchant: { select: { id: true, name: true, businessName: true } },
            provider: { select: { id: true, name: true, displayName: true } },
            settlementProfile: true,
            requestedBy: { select: { id: true, email: true, role: true } },
            reviewedBy: { select: { id: true, email: true, role: true } },
            events: {
              orderBy: { createdAt: 'asc' },
              include: {
                createdBy: { select: { id: true, email: true, role: true } }
              }
            }
          }
        }),
        prisma.payoutRequest.count({ where }),
        computeBalanceMap({
          merchantId: q.merchantId,
          providerId: q.providerId,
          currency: q.currency
        })
      ]);

      return {
        data: rows.map((row) => sanitizePayout(row, balanceMap.get(`${row.merchantId}:${row.currency}`) ?? '0')),
        summary: {
          availableComputedBalances: Array.from(balanceMap.entries()).map(([key, availableAmount]) => {
            const [merchantId, currency] = key.split(':');
            return {
              merchantId,
              currency,
              availableAmount
            };
          })
        },
        pagination: {
          total,
          page: q.page,
          limit: q.limit,
          pages: Math.ceil(total / q.limit)
        }
      };
    }
  );

  app.post(
    '/admin/payouts',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:write')],
      preValidation: validateBody(payoutCreateSchema)
    },
    async (request) => {
      const payload = request.body as PayoutCreatePayload;
      const validated = await validateCreateOrUpdatePayload({
        merchantId: payload.merchantId,
        settlementProfileId: payload.settlementProfileId,
        providerId: payload.providerId ?? null,
        amount: payload.amount,
        currency: payload.currency,
        countryCode: payload.countryCode,
        method: payload.method
      });

      const created = await prisma.$transaction(async (tx) => {
        const payout = await tx.payoutRequest.create({
          data: {
            merchantId: payload.merchantId,
            settlementProfileId: payload.settlementProfileId,
            providerId: validated.resolvedProviderId,
            amount: validated.amount,
            currency: payload.currency.toUpperCase(),
            countryCode: payload.countryCode.toUpperCase(),
            method: validated.method,
            status: PayoutStatus.PENDING_REVIEW,
            requestedById: request.adminUser?.id ?? null,
            internalNote: normalizeNote(payload.internalNote),
            metadata: {
              ...(isRecord(payload.metadata) ? payload.metadata : {}),
              destination: validated.destinationSnapshot,
              computedMode: 'settlement_v1_computed_unsettled'
            }
          },
          include: {
            merchant: { select: { id: true, name: true, businessName: true } },
            provider: { select: { id: true, name: true, displayName: true } },
            settlementProfile: true,
            requestedBy: { select: { id: true, email: true, role: true } },
            reviewedBy: { select: { id: true, email: true, role: true } },
            events: {
              orderBy: { createdAt: 'asc' },
              include: {
                createdBy: { select: { id: true, email: true, role: true } }
              }
            }
          }
        });

        await tx.payoutEvent.create({
          data: {
            payoutRequestId: payout.id,
            action: 'CREATED',
            fromStatus: null,
            toStatus: payout.status,
            note: normalizeNote(payload.internalNote),
            metadata: {
              amount: payout.amount.toString(),
              currency: payout.currency,
              method: payout.method,
              destination: validated.destinationSnapshot
            },
            createdById: request.adminUser?.id ?? null
          }
        });

        await tx.auditLog.create({
          data: {
            actorType: 'ADMIN',
            actorId: request.adminUser?.id ?? null,
            action: 'PAYOUT_CREATED',
            entityType: 'PayoutRequest',
            entityId: payout.id,
            ipAddress: request.ip,
            metadata: {
              merchantId: payout.merchantId,
              settlementProfileId: payout.settlementProfileId,
              providerId: payout.providerId,
              amount: payout.amount.toString(),
              currency: payout.currency,
              countryCode: payout.countryCode,
              method: payout.method,
              status: payout.status
            }
          }
        });

        return payout;
      });

      return {
        data: sanitizePayout(created, validated.availableBalance.toString())
      };
    }
  );

  app.get(
    '/admin/payouts/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:read')],
      preValidation: validateParams(payoutIdSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const payout = await prisma.payoutRequest.findUnique({
        where: { id },
        include: {
          merchant: { select: { id: true, name: true, businessName: true } },
          provider: { select: { id: true, name: true, displayName: true } },
          settlementProfile: true,
          requestedBy: { select: { id: true, email: true, role: true } },
          reviewedBy: { select: { id: true, email: true, role: true } },
          events: {
            orderBy: { createdAt: 'asc' },
            include: {
              createdBy: { select: { id: true, email: true, role: true } }
            }
          }
        }
      });

      if (!payout) {
        throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      }

      const balance = await computeAvailableBalance({
        merchantId: payout.merchantId,
        currency: payout.currency,
        excludePayoutId: payout.id
      });

      return {
        data: sanitizePayout(payout, balance.availableAmount.toString())
      };
    }
  );

  app.patch(
    '/admin/payouts/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:write')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutUpdateSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const payload = request.body as PayoutUpdatePayload;
      const existing = await prisma.payoutRequest.findUnique({
        where: { id },
        include: {
          merchant: { select: { id: true, name: true, businessName: true } },
          provider: { select: { id: true, name: true, displayName: true } },
          settlementProfile: true,
          requestedBy: { select: { id: true, email: true, role: true } },
          reviewedBy: { select: { id: true, email: true, role: true } },
          events: {
            orderBy: { createdAt: 'asc' },
            include: {
              createdBy: { select: { id: true, email: true, role: true } }
            }
          }
        }
      });

      if (!existing) {
        throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      }

      assertTransition(existing.status, [PayoutStatus.DRAFT, PayoutStatus.PENDING_REVIEW, PayoutStatus.MANUAL_REQUIRED], 'edit payout');

      const validated = await validateCreateOrUpdatePayload(
        {
          merchantId: existing.merchantId,
          settlementProfileId: payload.settlementProfileId ?? existing.settlementProfileId,
          providerId: payload.providerId !== undefined ? payload.providerId : existing.providerId,
          amount: payload.amount ?? existing.amount.toString(),
          currency: payload.currency ?? existing.currency,
          countryCode: payload.countryCode ?? existing.countryCode,
          method: payload.method ?? existing.method
        },
        { excludePayoutId: existing.id }
      );

      const updated = await prisma.$transaction(async (tx) => {
        const payout = await tx.payoutRequest.update({
          where: { id },
          data: {
            settlementProfileId: payload.settlementProfileId ?? existing.settlementProfileId,
            providerId: validated.resolvedProviderId,
            amount: payload.amount ? BigInt(payload.amount) : existing.amount,
            currency: payload.currency ? payload.currency.toUpperCase() : existing.currency,
            countryCode: payload.countryCode ? payload.countryCode.toUpperCase() : existing.countryCode,
            method: payload.method ?? existing.method,
            internalNote: payload.internalNote !== undefined ? normalizeNote(payload.internalNote) : existing.internalNote,
            failureReason: payload.failureReason !== undefined ? normalizeNote(payload.failureReason) : existing.failureReason,
            providerPayoutRef: payload.providerPayoutRef !== undefined ? normalizeNote(payload.providerPayoutRef) : existing.providerPayoutRef,
            metadata: {
              ...(isRecord(existing.metadata) ? existing.metadata : {}),
              ...(isRecord(payload.metadata) ? payload.metadata : {}),
              destination: validated.destinationSnapshot
            }
          },
          include: {
            merchant: { select: { id: true, name: true, businessName: true } },
            provider: { select: { id: true, name: true, displayName: true } },
            settlementProfile: true,
            requestedBy: { select: { id: true, email: true, role: true } },
            reviewedBy: { select: { id: true, email: true, role: true } },
            events: {
              orderBy: { createdAt: 'asc' },
              include: {
                createdBy: { select: { id: true, email: true, role: true } }
              }
            }
          }
        });

        await tx.payoutEvent.create({
          data: {
            payoutRequestId: payout.id,
            action: 'UPDATED',
            fromStatus: existing.status,
            toStatus: payout.status,
            note: normalizeNote(payload.internalNote) ?? 'Payout request updated',
            metadata: {
              providerId: payout.providerId,
              amount: payout.amount.toString(),
              currency: payout.currency,
              countryCode: payout.countryCode,
              method: payout.method
            },
            createdById: request.adminUser?.id ?? null
          }
        });

        await tx.auditLog.create({
          data: {
            actorType: 'ADMIN',
            actorId: request.adminUser?.id ?? null,
            action: 'PAYOUT_UPDATED',
            entityType: 'PayoutRequest',
            entityId: payout.id,
            ipAddress: request.ip,
            metadata: {
              merchantId: payout.merchantId,
              settlementProfileId: payout.settlementProfileId,
              providerId: payout.providerId,
              amount: payout.amount.toString(),
              currency: payout.currency,
              countryCode: payout.countryCode,
              method: payout.method,
              status: payout.status
            }
          }
        });

        return payout;
      });

      return {
        data: sanitizePayout(updated, validated.availableBalance.toString())
      };
    }
  );

  app.post(
    '/admin/payouts/:id/approve',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:approve')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.PENDING_REVIEW, PayoutStatus.MANUAL_REQUIRED], 'approve payout');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'APPROVED',
          toStatus: PayoutStatus.APPROVED,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note),
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : null,
          setApprovedAt: true
        })
      };
    }
  );

  app.post(
    '/admin/payouts/:id/reject',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:approve')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.DRAFT, PayoutStatus.PENDING_REVIEW, PayoutStatus.MANUAL_REQUIRED, PayoutStatus.APPROVED], 'reject payout');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'REJECTED',
          toStatus: PayoutStatus.REJECTED,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note),
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : null
        })
      };
    }
  );

  app.post(
    '/admin/payouts/:id/cancel',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:write')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.DRAFT, PayoutStatus.PENDING_REVIEW, PayoutStatus.APPROVED, PayoutStatus.MANUAL_REQUIRED], 'cancel payout');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'CANCELLED',
          toStatus: PayoutStatus.CANCELLED,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note),
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : null
        })
      };
    }
  );

  app.post(
    '/admin/payouts/:id/mark-manual-required',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:write')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.PENDING_REVIEW, PayoutStatus.APPROVED, PayoutStatus.PROCESSING], 'mark payout as manual required');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'MARKED_MANUAL_REQUIRED',
          toStatus: PayoutStatus.MANUAL_REQUIRED,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note),
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : null
        })
      };
    }
  );

  app.post(
    '/admin/payouts/:id/mark-processing',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:write')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.APPROVED, PayoutStatus.MANUAL_REQUIRED], 'mark payout as processing');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'MARKED_PROCESSING',
          toStatus: PayoutStatus.PROCESSING,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note),
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          providerPayoutRef: body.providerPayoutRef !== undefined ? normalizeNote(body.providerPayoutRef) : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : null,
          setProcessedAt: true
        })
      };
    }
  );

  app.post(
    '/admin/payouts/:id/mark-success',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:mark-success')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      ensurePayoutSuccessRole(request.adminUser!.role);
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.APPROVED, PayoutStatus.PROCESSING, PayoutStatus.MANUAL_REQUIRED], 'mark payout as success');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'MARKED_SUCCESS',
          toStatus: PayoutStatus.SUCCESS,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note) ?? 'Manually confirmed successful payout',
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          providerPayoutRef: body.providerPayoutRef !== undefined ? normalizeNote(body.providerPayoutRef) : undefined,
          metadata: {
            ...(isRecord(body.metadata) ? body.metadata : {}),
            manualConfirmation: true
          },
          setProcessedAt: true
        })
      };
    }
  );

  app.post(
    '/admin/payouts/:id/mark-failed',
    {
      preHandler: [requireAdminAuth, requirePermission('payouts:write')],
      preValidation: [validateParams(payoutIdSchema), validateBody(payoutActionBodySchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof payoutIdSchema>;
      const body = request.body as PayoutActionBody;
      if (!normalizeNote(body.failureReason)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Failure reason is required');
      }

      const existing = await prisma.payoutRequest.findUnique({ where: { id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Payout request not found');
      assertTransition(existing.status, [PayoutStatus.APPROVED, PayoutStatus.PROCESSING, PayoutStatus.MANUAL_REQUIRED], 'mark payout as failed');

      return {
        data: await transitionPayout({
          payoutId: id,
          action: 'MARKED_FAILED',
          toStatus: PayoutStatus.FAILED,
          adminId: request.adminUser?.id ?? null,
          ipAddress: request.ip,
          note: normalizeNote(body.note),
          internalNote: body.internalNote !== undefined ? normalizeNote(body.internalNote) : undefined,
          failureReason: normalizeNote(body.failureReason),
          providerPayoutRef: body.providerPayoutRef !== undefined ? normalizeNote(body.providerPayoutRef) : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : null,
          setProcessedAt: true
        })
      };
    }
  );
};
