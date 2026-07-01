import type { FastifyPluginAsync } from 'fastify';
import { CredentialScope, PaymentPurpose, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody, validateParams, validateQuery } from '../../utils/validation.js';

const settlementTypeSchema = z.enum(['BANK_ACCOUNT', 'MOBILE_WALLET', 'ACCOUNT']);

const bigIntLikeSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => value.toString())
  .refine((value) => /^\d+$/.test(value), 'Minimum amount must be a non-negative whole number');

const bankDetailsSchema = z.object({
  bankName: z.string().min(1).max(120),
  accountName: z.string().min(1).max(120),
  accountNumber: z.string().min(4).max(40),
  routingNumber: z.string().min(2).max(40).optional().nullable(),
  swiftCode: z.string().min(3).max(20).optional().nullable(),
  iban: z.string().min(5).max(40).optional().nullable(),
  branchName: z.string().min(1).max(120).optional().nullable()
});

const mobileWalletDetailsSchema = z.object({
  providerName: z.string().min(1).max(120),
  walletId: z.string().min(1).max(120).optional().nullable(),
  accountName: z.string().min(1).max(120).optional().nullable(),
  mobileNumber: z.string().min(4).max(40).optional().nullable()
});

const accountDetailsSchema = z.object({
  accountName: z.string().min(1).max(120),
  accountNumber: z.string().min(4).max(40),
  accountType: z.string().min(1).max(60).optional().nullable(),
  branchName: z.string().min(1).max(120).optional().nullable()
});

const settlementProfilePayloadSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  merchantId: z.string().min(1).max(120).nullable().optional(),
  providerId: z.string().min(1).max(120).nullable().optional(),
  settlementType: settlementTypeSchema.optional(),
  countryCode: z.string().min(2).max(3).optional(),
  currencyCode: z.string().min(3).max(3).optional(),
  minimumAmount: bigIntLikeSchema.optional(),
  isActive: z.boolean().optional(),
  purpose: z.nativeEnum(PaymentPurpose).nullable().optional(),
  payoutSchedule: z.string().max(120).nullable().optional(),
  bankDetails: bankDetailsSchema.nullable().optional(),
  mobileWalletDetails: mobileWalletDetailsSchema.nullable().optional(),
  accountDetails: accountDetailsSchema.nullable().optional()
});

const settlementProfileListQuerySchema = z.object({
  search: z.string().optional(),
  merchantId: z.string().optional(),
  providerId: z.string().optional(),
  countryCode: z.string().optional(),
  currencyCode: z.string().optional(),
  settlementType: settlementTypeSchema.optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all')
});

const settlementOverviewQuerySchema = z.object({
  merchantId: z.string().optional(),
  providerId: z.string().optional(),
  currencyCode: z.string().optional()
});

const settlementProfileIdSchema = z.object({
  id: z.string().min(1)
});

type SettlementProfilePayload = z.infer<typeof settlementProfilePayloadSchema>;

type SettlementProfileMetadata = {
  merchantId?: string | null;
  providerId?: string | null;
  settlementType: z.infer<typeof settlementTypeSchema>;
  minimumAmount: string | null;
  bankDetails?: z.infer<typeof bankDetailsSchema> | null;
  mobileWalletDetails?: z.infer<typeof mobileWalletDetailsSchema> | null;
  accountDetails?: z.infer<typeof accountDetailsSchema> | null;
};

type OverviewGroupRow = {
  merchantId: string;
  merchantName: string;
  providerId: string;
  providerName: string;
  currency: string;
  grossAmount: string;
  refundedExcludedAmount: string;
  pendingManualReviewAmount: string;
  transactionCount: number;
  refundCount: number;
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

const buildMetadata = (payload: SettlementProfilePayload, existing?: SettlementProfileMetadata): SettlementProfileMetadata => {
  const settlementType = payload.settlementType ?? existing?.settlementType ?? 'BANK_ACCOUNT';

  return {
    merchantId: payload.merchantId ?? existing?.merchantId ?? null,
    providerId: payload.providerId ?? existing?.providerId ?? null,
    settlementType,
    minimumAmount: payload.minimumAmount ?? existing?.minimumAmount ?? null,
    bankDetails: payload.bankDetails ?? existing?.bankDetails ?? null,
    mobileWalletDetails: payload.mobileWalletDetails ?? existing?.mobileWalletDetails ?? null,
    accountDetails: payload.accountDetails ?? existing?.accountDetails ?? null
  };
};

const validateSettlementPayload = (payload: SettlementProfilePayload, mode: 'create' | 'update') => {
  const settlementType = payload.settlementType;

  if (mode === 'create') {
    if (!payload.name) throw new ApiError(400, 'VALIDATION_ERROR', 'Settlement profile name is required');
    if (!settlementType) throw new ApiError(400, 'VALIDATION_ERROR', 'Settlement type is required');
    if (!payload.countryCode) throw new ApiError(400, 'VALIDATION_ERROR', 'Country code is required');
    if (!payload.currencyCode) throw new ApiError(400, 'VALIDATION_ERROR', 'Currency code is required');
    if (!payload.minimumAmount) throw new ApiError(400, 'VALIDATION_ERROR', 'Minimum amount is required');
  }

  const resolvedType = settlementType ?? 'BANK_ACCOUNT';

  if (resolvedType === 'BANK_ACCOUNT' && !payload.bankDetails && mode === 'create') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Bank details are required for BANK_ACCOUNT settlements');
  }

  if (resolvedType === 'MOBILE_WALLET' && !payload.mobileWalletDetails && mode === 'create') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Mobile wallet details are required for MOBILE_WALLET settlements');
  }

  if (resolvedType === 'ACCOUNT' && !payload.accountDetails && mode === 'create') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Account details are required for ACCOUNT settlements');
  }

  if (payload.minimumAmount !== undefined && payload.minimumAmount !== null) {
    if (BigInt(payload.minimumAmount) < 0n) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Minimum amount must be non-negative');
    }
  }
};

const sanitizeProfile = (profile: any) => {
  const metadata = isRecord(profile.metadata) ? profile.metadata : {};
  const bankDetails = isRecord(metadata.bankDetails) ? metadata.bankDetails : null;
  const mobileWalletDetails = isRecord(metadata.mobileWalletDetails) ? metadata.mobileWalletDetails : null;
  const accountDetails = isRecord(metadata.accountDetails) ? metadata.accountDetails : null;

  const minimumAmount = typeof metadata.minimumAmount === 'string'
    ? metadata.minimumAmount
    : typeof metadata.minimumAmount === 'number' || typeof metadata.minimumAmount === 'bigint'
      ? String(metadata.minimumAmount)
      : null;

  return {
    id: profile.id,
    name: profile.name,
    scopeType: profile.scopeType,
    scopeId: profile.scopeId,
    countryCode: profile.countryCode,
    currencyCode: profile.currencyCode,
    purpose: profile.purpose,
    payoutSchedule: profile.payoutSchedule,
    isActive: profile.isActive,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    merchantId: typeof metadata.merchantId === 'string' ? metadata.merchantId : null,
    providerId: typeof metadata.providerId === 'string' ? metadata.providerId : null,
    settlementType: typeof metadata.settlementType === 'string' ? metadata.settlementType : 'BANK_ACCOUNT',
    minimumAmount,
    bankDetails: bankDetails
      ? {
          bankName: typeof bankDetails.bankName === 'string' ? bankDetails.bankName : null,
          accountName: typeof bankDetails.accountName === 'string' ? bankDetails.accountName : null,
          accountNumberMasked: maskAccountNumber(bankDetails.accountNumber),
          routingNumberMasked: maskAccountNumber(bankDetails.routingNumber),
          swiftCode: typeof bankDetails.swiftCode === 'string' ? bankDetails.swiftCode : null,
          ibanMasked: maskAccountNumber(bankDetails.iban),
          branchName: typeof bankDetails.branchName === 'string' ? bankDetails.branchName : null
        }
      : null,
    mobileWalletDetails: mobileWalletDetails
      ? {
          providerName: typeof mobileWalletDetails.providerName === 'string' ? mobileWalletDetails.providerName : null,
          walletIdMasked: maskAccountNumber(mobileWalletDetails.walletId),
          accountName: typeof mobileWalletDetails.accountName === 'string' ? mobileWalletDetails.accountName : null,
          mobileNumberMasked: maskAccountNumber(mobileWalletDetails.mobileNumber)
        }
      : null,
    accountDetails: accountDetails
      ? {
          accountName: typeof accountDetails.accountName === 'string' ? accountDetails.accountName : null,
          accountNumberMasked: maskAccountNumber(accountDetails.accountNumber),
          accountType: typeof accountDetails.accountType === 'string' ? accountDetails.accountType : null,
          branchName: typeof accountDetails.branchName === 'string' ? accountDetails.branchName : null
        }
      : null,
    counts: {
      credentialProfiles: profile._count?.credentialProfiles ?? 0,
      paymentSessions: profile._count?.paymentSessions ?? 0
    }
  };
};

const buildProfileFilters = (profiles: any[], q: z.infer<typeof settlementProfileListQuerySchema>) =>
  profiles.filter((profile) => {
    const metadata = isRecord(profile.metadata) ? profile.metadata : {};
    const merchantId = typeof metadata.merchantId === 'string' ? metadata.merchantId : null;
    const providerId = typeof metadata.providerId === 'string' ? metadata.providerId : null;
    const settlementType = typeof metadata.settlementType === 'string' ? metadata.settlementType : 'BANK_ACCOUNT';
    const countryCode = profile.countryCode?.toUpperCase?.() ?? profile.countryCode;
    const currencyCode = profile.currencyCode?.toUpperCase?.() ?? profile.currencyCode;

    if (q.status === 'active' && !profile.isActive) return false;
    if (q.status === 'inactive' && profile.isActive) return false;
    if (q.merchantId && merchantId !== q.merchantId) return false;
    if (q.providerId && providerId !== q.providerId) return false;
    if (q.countryCode && countryCode !== q.countryCode.toUpperCase()) return false;
    if (q.currencyCode && currencyCode !== q.currencyCode.toUpperCase()) return false;
    if (q.settlementType && settlementType !== q.settlementType) return false;

    if (q.search) {
      const search = q.search.toLowerCase();
      const haystack = [
        profile.name,
        profile.countryCode,
        profile.currencyCode,
        merchantId,
        providerId,
        settlementType,
        profile.payoutSchedule ?? ''
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });

const nonEmptyString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

const mergeScalarValue = (incoming: unknown, existing: unknown) => {
  const normalized = nonEmptyString(incoming);
  if (normalized !== null) return normalized;
  return typeof existing === 'string' && existing.trim().length > 0 ? existing : null;
};

const mergeRequiredDetailValue = (incoming: unknown, existing: unknown, fieldName: string) => {
  const merged = mergeScalarValue(incoming, existing);
  if (merged === null) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${fieldName} is required`);
  }
  return merged;
};

const mergeDetailValue = (incoming: unknown, existing: unknown) => {
  return mergeScalarValue(incoming, existing);
};

type OverviewTxnRow = {
  merchantId: string;
  merchantName: string;
  providerId: string;
  providerName: string;
  currency: string;
  grossAmount: string;
  transactionCount: number;
};

type OverviewRefundRow = {
  merchantId: string;
  merchantName: string;
  providerId: string;
  providerName: string;
  currency: string;
  refundedExcludedAmount: string;
  pendingManualReviewAmount: string;
  refundCount: number;
};

const RESTRICTED_ROLES = new Set(['SUPPORT', 'AUDITOR', 'DEVELOPER']);

const mergeOverviewRows = (transactions: OverviewTxnRow[], refunds: OverviewRefundRow[]) => {
  const rows = new Map<string, OverviewGroupRow>();

  for (const txn of transactions) {
    const key = [txn.merchantId, txn.providerId, txn.currency].join(':');
    rows.set(key, {
      merchantId: txn.merchantId,
      merchantName: txn.merchantName,
      providerId: txn.providerId,
      providerName: txn.providerName,
      currency: txn.currency,
      grossAmount: txn.grossAmount,
      refundedExcludedAmount: '0',
      pendingManualReviewAmount: '0',
      transactionCount: txn.transactionCount,
      refundCount: 0
    });
  }

  for (const refund of refunds) {
    const key = [refund.merchantId, refund.providerId, refund.currency].join(':');
    const existing = rows.get(key) ?? {
      merchantId: refund.merchantId,
      merchantName: refund.merchantName,
      providerId: refund.providerId,
      providerName: refund.providerName,
      currency: refund.currency,
      grossAmount: '0',
      refundedExcludedAmount: '0',
      pendingManualReviewAmount: '0',
      transactionCount: 0,
      refundCount: 0
    };

    const refundedExcluded = BigInt(existing.refundedExcludedAmount) + BigInt(refund.refundedExcludedAmount);
    const pendingManualReview = BigInt(existing.pendingManualReviewAmount) + BigInt(refund.pendingManualReviewAmount);

    rows.set(key, {
      ...existing,
      refundedExcludedAmount: refundedExcluded.toString(),
      pendingManualReviewAmount: pendingManualReview.toString(),
      refundCount: existing.refundCount + refund.refundCount
    });
  }

  return Array.from(rows.values()).map((row) => {
    const gross = BigInt(row.grossAmount);
    const refundedExcluded = BigInt(row.refundedExcludedAmount);
    return {
      ...row,
      computedUnsettledAmount: (gross - refundedExcluded).toString()
    };
  });
};

const requireMerchantFilterForRestrictedRole = (role: string, merchantId?: string | null) => {
  if (RESTRICTED_ROLES.has(role) && !merchantId) {
    throw new ApiError(400, 'MERCHANT_FILTER_REQUIRED', 'Your role requires a merchantId filter to query settlement data.');
  }
};

export const settlementRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/settlement-profiles',
    {
      preHandler: [requireAdminAuth, requirePermission('settlement-profiles:read')],
      preValidation: validateQuery(settlementProfileListQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof settlementProfileListQuerySchema>;
      requireMerchantFilterForRestrictedRole(request.adminUser!.role, q.merchantId);

      const profiles = await prisma.settlementProfile.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              credentialProfiles: true,
              paymentSessions: true
            }
          }
        }
      });

      const filtered = buildProfileFilters(profiles, q);

      return {
        data: filtered.map((profile) => sanitizeProfile(profile))
      };
    }
  );

  app.post(
    '/admin/settlement-profiles',
    {
      preHandler: [requireAdminAuth, requirePermission('settlement-profiles:write')],
      preValidation: validateBody(settlementProfilePayloadSchema)
    },
    async (request) => {
      const payload = request.body as SettlementProfilePayload;
      validateSettlementPayload(payload, 'create');

      const metadata = buildMetadata(payload);
      const profile = await prisma.settlementProfile.create({
        data: {
          name: payload.name!,
          scopeType: payload.merchantId ? CredentialScope.MERCHANT : CredentialScope.PLATFORM,
          scopeId: payload.merchantId ?? null,
          countryCode: uppercaseOrNull(payload.countryCode!)!,
          currencyCode: uppercaseOrNull(payload.currencyCode!)!,
          purpose: payload.purpose ?? null,
          payoutSchedule: payload.payoutSchedule ?? null,
          metadata,
          isActive: payload.isActive ?? true
        },
        include: {
          _count: {
            select: {
              credentialProfiles: true,
              paymentSessions: true
            }
          }
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'SETTLEMENT_PROFILE_CREATED',
          entityType: 'SettlementProfile',
          entityId: profile.id,
          ipAddress: request.ip,
          metadata: {
            name: profile.name,
            settlementType: metadata.settlementType,
            merchantId: metadata.merchantId,
            providerId: metadata.providerId,
            countryCode: profile.countryCode,
            currencyCode: profile.currencyCode,
            isActive: profile.isActive
          }
        }
      });

      return {
        data: sanitizeProfile(profile)
      };
    }
  );

  app.get(
    '/admin/settlement-profiles/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('settlement-profiles:read')],
      preValidation: validateParams(settlementProfileIdSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof settlementProfileIdSchema>;
      const profile = await prisma.settlementProfile.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              credentialProfiles: true,
              paymentSessions: true
            }
          }
        }
      });

      if (!profile) {
        throw new ApiError(404, 'NOT_FOUND', 'Settlement profile not found');
      }

      return {
        data: sanitizeProfile(profile)
      };
    }
  );

  app.patch(
    '/admin/settlement-profiles/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('settlement-profiles:write')],
      preValidation: [
        validateParams(settlementProfileIdSchema),
        validateBody(settlementProfilePayloadSchema)
      ]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof settlementProfileIdSchema>;
      const payload = request.body as SettlementProfilePayload;
      const existing = await prisma.settlementProfile.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              credentialProfiles: true,
              paymentSessions: true
            }
          }
        }
      });

      if (!existing) {
        throw new ApiError(404, 'NOT_FOUND', 'Settlement profile not found');
      }

      const existingMetadata = isRecord(existing.metadata) ? existing.metadata : {};
      const existingBankDetails = isRecord(existingMetadata.bankDetails) ? existingMetadata.bankDetails : null;
      const existingMobileWalletDetails = isRecord(existingMetadata.mobileWalletDetails) ? existingMetadata.mobileWalletDetails : null;
      const existingAccountDetails = isRecord(existingMetadata.accountDetails) ? existingMetadata.accountDetails : null;

      const merged: SettlementProfilePayload = {
        name: mergeScalarValue(payload.name, existing.name) ?? existing.name,
        merchantId: mergeScalarValue(payload.merchantId, existingMetadata.merchantId) ?? (typeof existingMetadata.merchantId === 'string' ? existingMetadata.merchantId : null),
        providerId: mergeScalarValue(payload.providerId, existingMetadata.providerId) ?? (typeof existingMetadata.providerId === 'string' ? existingMetadata.providerId : null),
        settlementType: payload.settlementType ?? (typeof existingMetadata.settlementType === 'string' ? existingMetadata.settlementType as z.infer<typeof settlementTypeSchema> : 'BANK_ACCOUNT'),
        countryCode: mergeScalarValue(payload.countryCode, existing.countryCode) ?? existing.countryCode,
        currencyCode: mergeScalarValue(payload.currencyCode, existing.currencyCode) ?? existing.currencyCode,
        minimumAmount: mergeScalarValue(payload.minimumAmount, existingMetadata.minimumAmount) ?? (typeof existingMetadata.minimumAmount === 'string' ? existingMetadata.minimumAmount : undefined),
        isActive: payload.isActive ?? existing.isActive,
        purpose: payload.purpose !== undefined ? payload.purpose : existing.purpose,
        payoutSchedule: payload.payoutSchedule !== undefined ? payload.payoutSchedule : existing.payoutSchedule,
        bankDetails: existingBankDetails
          ? {
              bankName: mergeRequiredDetailValue(payload.bankDetails?.bankName, existingBankDetails.bankName, 'Bank name'),
              accountName: mergeRequiredDetailValue(payload.bankDetails?.accountName, existingBankDetails.accountName, 'Bank account name'),
              accountNumber: mergeRequiredDetailValue(payload.bankDetails?.accountNumber, existingBankDetails.accountNumber, 'Bank account number'),
              routingNumber: mergeDetailValue(payload.bankDetails?.routingNumber, existingBankDetails.routingNumber),
              swiftCode: mergeDetailValue(payload.bankDetails?.swiftCode, existingBankDetails.swiftCode),
              iban: mergeDetailValue(payload.bankDetails?.iban, existingBankDetails.iban),
              branchName: mergeDetailValue(payload.bankDetails?.branchName, existingBankDetails.branchName)
            }
          : payload.bankDetails
            ? payload.bankDetails
            : undefined,
        mobileWalletDetails: existingMobileWalletDetails
          ? {
              providerName: mergeRequiredDetailValue(payload.mobileWalletDetails?.providerName, existingMobileWalletDetails.providerName, 'Wallet provider name'),
              walletId: mergeDetailValue(payload.mobileWalletDetails?.walletId, existingMobileWalletDetails.walletId),
              accountName: mergeDetailValue(payload.mobileWalletDetails?.accountName, existingMobileWalletDetails.accountName),
              mobileNumber: mergeDetailValue(payload.mobileWalletDetails?.mobileNumber, existingMobileWalletDetails.mobileNumber)
            }
          : payload.mobileWalletDetails
            ? payload.mobileWalletDetails
            : undefined,
        accountDetails: existingAccountDetails
          ? {
              accountName: mergeRequiredDetailValue(payload.accountDetails?.accountName, existingAccountDetails.accountName, 'Account name'),
              accountNumber: mergeRequiredDetailValue(payload.accountDetails?.accountNumber, existingAccountDetails.accountNumber, 'Account number'),
              accountType: mergeDetailValue(payload.accountDetails?.accountType, existingAccountDetails.accountType),
              branchName: mergeDetailValue(payload.accountDetails?.branchName, existingAccountDetails.branchName)
            }
          : payload.accountDetails
            ? payload.accountDetails
            : undefined
      };

      validateSettlementPayload(merged, 'update');
      const metadata = buildMetadata(merged, isRecord(existing.metadata) ? (existing.metadata as SettlementProfileMetadata) : undefined);

      const updated = await prisma.settlementProfile.update({
        where: { id },
        data: {
          name: merged.name!,
          scopeType: merged.merchantId ? CredentialScope.MERCHANT : CredentialScope.PLATFORM,
          scopeId: merged.merchantId ?? null,
          countryCode: uppercaseOrNull(merged.countryCode!)!,
          currencyCode: uppercaseOrNull(merged.currencyCode!)!,
          purpose: merged.purpose ?? null,
          payoutSchedule: merged.payoutSchedule ?? null,
          metadata,
          isActive: merged.isActive ?? true
        },
        include: {
          _count: {
            select: {
              credentialProfiles: true,
              paymentSessions: true
            }
          }
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'SETTLEMENT_PROFILE_UPDATED',
          entityType: 'SettlementProfile',
          entityId: updated.id,
          ipAddress: request.ip,
          metadata: {
            name: updated.name,
            settlementType: metadata.settlementType,
            merchantId: metadata.merchantId,
            providerId: metadata.providerId,
            countryCode: updated.countryCode,
            currencyCode: updated.currencyCode,
            isActive: updated.isActive
          }
        }
      });

      return {
        data: sanitizeProfile(updated)
      };
    }
  );

  app.delete(
    '/admin/settlement-profiles/:id',
    {
      preHandler: [requireAdminAuth, requirePermission('settlement-profiles:write')],
      preValidation: validateParams(settlementProfileIdSchema)
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof settlementProfileIdSchema>;
      const existing = await prisma.settlementProfile.findUnique({ where: { id } });

      if (!existing) {
        throw new ApiError(404, 'NOT_FOUND', 'Settlement profile not found');
      }

      if (!existing.isActive) {
        return {
          data: {
            id: existing.id,
            isActive: false,
            message: 'Settlement profile already inactive'
          }
        };
      }

      const updated = await prisma.settlementProfile.update({
        where: { id },
        data: { isActive: false }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'SETTLEMENT_PROFILE_DISABLED',
          entityType: 'SettlementProfile',
          entityId: updated.id,
          ipAddress: request.ip,
          metadata: {
            name: updated.name,
            settlementType: isRecord(updated.metadata) && typeof updated.metadata.settlementType === 'string' ? updated.metadata.settlementType : null,
            isActive: updated.isActive
          }
        }
      });

      return {
        data: {
          id: updated.id,
          isActive: updated.isActive
        }
      };
    }
  );

  app.get(
    '/admin/settlements',
    {
      preHandler: [requireAdminAuth, requirePermission('settlements:read')],
      preValidation: validateQuery(settlementOverviewQuerySchema)
    },
    async (request) => {
      const q = request.query as z.infer<typeof settlementOverviewQuerySchema>;
      requireMerchantFilterForRestrictedRole(request.adminUser!.role, q.merchantId);
      const currencyCode = uppercaseOrNull(q.currencyCode);

      const [transactionRows, refundRows] = await Promise.all([
        prisma.$queryRaw<OverviewTxnRow[]>(Prisma.sql`
          SELECT
            m.id AS "merchantId",
            m.name AS "merchantName",
            p.id AS "providerId",
            p.display_name AS "providerName",
            t.currency AS currency,
            COALESCE(SUM(t.amount), 0)::text AS "grossAmount",
            COUNT(*)::int AS "transactionCount"
          FROM transactions t
          JOIN payment_sessions s ON s.id = t.session_id
          JOIN merchants m ON m.id = s.merchant_id
          JOIN payment_providers p ON p.id = t.provider_id
          WHERE t.status IN ('SUCCESS', 'CAPTURED')
            AND (${q.merchantId ?? null}::text IS NULL OR m.id = ${q.merchantId ?? null})
            AND (${q.providerId ?? null}::text IS NULL OR p.id = ${q.providerId ?? null})
            AND (${currencyCode}::text IS NULL OR t.currency = ${currencyCode})
          GROUP BY m.id, m.name, p.id, p.display_name, t.currency
          ORDER BY m.name ASC, p.display_name ASC, t.currency ASC
        `),
        prisma.$queryRaw<OverviewRefundRow[]>(Prisma.sql`
          SELECT
            m.id AS "merchantId",
            m.name AS "merchantName",
            p.id AS "providerId",
            p.display_name AS "providerName",
            r.currency AS currency,
            COALESCE(SUM(CASE WHEN r.status = 'SUCCESS' THEN r.amount ELSE 0 END), 0)::text AS "refundedExcludedAmount",
            COALESCE(SUM(CASE WHEN r.status IN ('PENDING_MANUAL_REVIEW', 'PROCESSING') THEN r.amount ELSE 0 END), 0)::text AS "pendingManualReviewAmount",
            COUNT(*)::int AS "refundCount"
          FROM refunds r
          JOIN transactions t ON t.id = r.transaction_id
          JOIN payment_sessions s ON s.id = r.session_id
          JOIN merchants m ON m.id = r.merchant_id
          JOIN payment_providers p ON p.id = r.provider_id
          WHERE (${q.merchantId ?? null}::text IS NULL OR m.id = ${q.merchantId ?? null})
            AND (${q.providerId ?? null}::text IS NULL OR p.id = ${q.providerId ?? null})
            AND (${currencyCode}::text IS NULL OR r.currency = ${currencyCode})
          GROUP BY m.id, m.name, p.id, p.display_name, r.currency
          ORDER BY m.name ASC, p.display_name ASC, r.currency ASC
        `)
      ]);

      const overviewRows = mergeOverviewRows(transactionRows, refundRows);
      const grossAmount = overviewRows.reduce((sum, row) => sum + BigInt(row.grossAmount), 0n);
      const refundedExcludedAmount = overviewRows.reduce((sum, row) => sum + BigInt(row.refundedExcludedAmount), 0n);
      const pendingManualReviewAmount = overviewRows.reduce((sum, row) => sum + BigInt(row.pendingManualReviewAmount), 0n);
      const computedUnsettledAmount = grossAmount - refundedExcludedAmount;

      return {
        data: {
          mode: 'computed_unsettled',
          computed: true,
          generatedAt: new Date().toISOString(),
          summary: {
            settledAmount: '0',
            unsettledAmount: computedUnsettledAmount.toString(),
            grossAmount: grossAmount.toString(),
            refundedExcludedAmount: refundedExcludedAmount.toString(),
            pendingManualReviewAmount: pendingManualReviewAmount.toString(),
            transactionCount: overviewRows.reduce((sum, row) => sum + row.transactionCount, 0),
            refundCount: overviewRows.reduce((sum, row) => sum + row.refundCount, 0)
          },
          settled: {
            note: 'Settlement execution is not implemented in v1.',
            items: []
          },
          unsettled: {
            note: 'Computed from successful/captured transactions and refund activity.',
            items: overviewRows.map((row) => ({
              ...row,
              isComputed: true
            }))
          },
          pendingManualReview: {
            items: overviewRows.filter((row) => BigInt(row.pendingManualReviewAmount) > 0n)
          },
          refundedExcluded: {
            items: overviewRows.filter((row) => BigInt(row.refundedExcludedAmount) > 0n)
          }
        }
      };
    }
  );
};
