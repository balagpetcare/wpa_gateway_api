import type { Prisma, TransactionStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { getProviderAdapter } from '../providers/index.js';
import { assertProviderReadyForPayments } from '../providers/readiness.js';
import { createAuditLog } from './audit.js';
import { sendCentralCommunicationEvent } from './central-communication.js';
import { deliverMerchantCallback } from './callback-delivery.js';
import { getDecryptedCredentialsForSession, getDecryptedProviderCredentials } from './provider-credentials.js';
import { selectActiveProvider } from './provider-selection.js';
import { minorUnitsToDecimalString } from '../utils/money.js';

const payloadString = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const mergeJson = (current: unknown, next: Record<string, unknown>): Prisma.InputJsonValue =>
  ({
    ...(typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {}),
    ...next
  }) as Prisma.InputJsonValue;

const parseRawBody = (rawBody: string) => {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return {} as Record<string, unknown>;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(trimmed));
  }
};

export const createProviderPayment = async (input: {
  merchantId: string;
  sessionId: string;
  orderId: string;
  amount: number;
  currency: string;
  country?: string;
  purpose: string;
  customer: {
    name: string;
    email: string;
    phone?: string;
    country?: string;
  };
  successUrl: string;
  cancelUrl: string;
  callbackUrl: string;
  requestIp?: string;
}) => {
  const provider = await selectActiveProvider({
    merchantId: input.merchantId,
    currency: input.currency,
    country: input.country
  });

  const credentials = await getDecryptedProviderCredentials({
    providerId: provider.id,
    merchantId: input.merchantId
  });

  const adapter = getProviderAdapter(provider);
  assertProviderReadyForPayments(provider);

  await createAuditLog({
    actorType: 'SYSTEM',
    actorId: null,
    action: 'PROVIDER_CREATE_PAYMENT_REQUEST',
    entityType: 'PaymentProvider',
    entityId: provider.id,
    ipAddress: input.requestIp ?? null,
    metadata: {
      merchantId: input.merchantId,
      sessionId: input.sessionId,
      currency: input.currency,
      country: input.country ?? null,
      credentialLabels: Object.keys(credentials)
    }
  });

  const result = await adapter.createPayment({
    sessionId: input.sessionId,
    merchantId: input.merchantId,
    orderId: input.orderId,
    amount: input.amount,
    amountMinor: String(Math.trunc(input.amount)),
    amountDecimal: minorUnitsToDecimalString(String(Math.trunc(input.amount)), 2),
    currency: input.currency,
    country: input.country,
    purpose: input.purpose,
    customer: input.customer,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    callbackUrl: input.callbackUrl,
    credentials
  });

  await createAuditLog({
    actorType: 'SYSTEM',
    actorId: null,
    action: 'PROVIDER_CREATE_PAYMENT_RESPONSE',
    entityType: 'PaymentProvider',
    entityId: provider.id,
    ipAddress: input.requestIp ?? null,
    metadata: {
      merchantId: input.merchantId,
      sessionId: input.sessionId,
      providerReference: result.providerReference,
      providerSessionId: result.providerSessionId
    }
  });

  return {
    provider,
    result
  };
};

export const processProviderWebhook = async (input: {
  providerId: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  requestIp?: string;
}) => {
  const provider = await prisma.paymentProvider.findUniqueOrThrow({
    where: { id: input.providerId }
  });

  const parsedPayload = parseRawBody(input.rawBody);
  const hintedProviderReference = payloadString(parsedPayload, 'providerReference', 'merchantInvoiceNumber', 'MerchantTransactionId', 'trxID');
  const hintedProviderSessionId = payloadString(parsedPayload, 'providerSessionId', 'paymentID', 'providerPaymentID', 'EPSTransactionId', 'TransactionId');
  const hintedOrderId = payloadString(parsedPayload, 'merchantOrderId', 'merchantInvoiceNumber', 'CustomerOrderId', 'orderId', 'OrderId');

  const hintedSession =
    hintedProviderReference || hintedProviderSessionId
      ? await prisma.paymentSession.findFirst({
          where: {
            providerId: provider.id,
            OR: [
              ...(hintedProviderReference ? [{ providerReference: hintedProviderReference }] : []),
              ...(hintedProviderSessionId ? [{ providerSessionId: hintedProviderSessionId }] : [])
            ]
          },
          select: {
            id: true,
            merchantId: true,
            credentialProfileId: true
          }
        })
      : hintedOrderId
        ? await prisma.paymentSession.findFirst({
            where: {
              providerId: provider.id,
              orderId: hintedOrderId
            },
            select: {
              id: true,
              merchantId: true,
              credentialProfileId: true
            }
          })
        : null;

  const credentials = hintedSession
    ? await getDecryptedCredentialsForSession({
        providerId: provider.id,
        merchantId: hintedSession.merchantId,
        credentialProfileId: hintedSession.credentialProfileId
      }).catch(() => ({}))
    : await getDecryptedProviderCredentials({
        providerId: provider.id,
        merchantId: ''
      }).catch(() => ({}));

  const adapter = getProviderAdapter(provider);
  const result = await adapter.handleWebhook({
    headers: input.headers,
    rawBody: input.rawBody,
    method: input.headers['x-http-method-override'] as string | undefined,
    credentials
  });

  const existingLog = await prisma.webhookLog.findFirst({
    where: {
      providerId: provider.id,
      providerEventId: result.providerEventId
    }
  });

  if (existingLog?.processedAt) {
    const existingSession = existingLog.sessionId
      ? await prisma.paymentSession.findUnique({
          where: { id: existingLog.sessionId },
          select: { id: true, reference: true }
        })
      : null;

    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'PROVIDER_WEBHOOK_DUPLICATE_IGNORED',
      entityType: 'WebhookLog',
      entityId: existingLog.id,
      ipAddress: input.requestIp ?? null,
      metadata: {
        providerId: provider.id,
        providerEventId: result.providerEventId
      }
    });

    return {
      duplicate: true,
      verified: true,
      matched: !!existingSession,
      sessionId: existingSession?.id ?? existingLog.sessionId,
      sessionReference: existingSession?.reference,
      status: existingLog.status,
      callbackStatus: 'SUCCESS'
    };
  }

  let session = null;
  if (result.providerReference || result.providerSessionId) {
    session = await prisma.paymentSession.findFirst({
      where: {
        providerId: provider.id,
        OR: [
          ...(result.providerReference ? [{ providerReference: result.providerReference }] : []),
          ...(result.providerSessionId ? [{ providerSessionId: result.providerSessionId }] : [])
        ]
      },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
  }

  if (!session && result.merchantOrderId) {
    session = await prisma.paymentSession.findFirst({
      where: {
        providerId: provider.id,
        orderId: result.merchantOrderId
      },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
  }

  const webhookLog = existingLog
    ? await prisma.webhookLog.update({
        where: { id: existingLog.id },
        data: {
          sessionId: session?.id ?? existingLog.sessionId,
          requestHeaders: input.headers as Prisma.InputJsonValue,
          rawPayload: result.payload as Prisma.InputJsonValue,
          status: result.isVerified ? 'SUCCESS' : 'FAILED',
          processedAt: new Date()
        }
      })
    : await prisma.webhookLog.create({
        data: {
          sessionId: session?.id ?? null,
          providerId: provider.id,
          providerEventId: result.providerEventId,
          requestHeaders: input.headers as Prisma.InputJsonValue,
          rawPayload: result.payload as Prisma.InputJsonValue,
          status: result.isVerified ? 'SUCCESS' : 'FAILED',
          processedAt: new Date()
        }
      });

  if (!result.isVerified) {
    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'PROVIDER_WEBHOOK_REJECTED',
      entityType: 'WebhookLog',
      entityId: webhookLog.id,
      ipAddress: input.requestIp ?? null,
      metadata: {
        providerId: provider.id,
        providerEventId: result.providerEventId
      }
    });

    return {
      duplicate: false,
      verified: false,
      sessionId: session?.id ?? null
    };
  }

  if (!session) {
    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'PROVIDER_WEBHOOK_UNMATCHED',
      entityType: 'WebhookLog',
      entityId: webhookLog.id,
      ipAddress: input.requestIp ?? null,
      metadata: {
        providerId: provider.id,
        providerEventId: result.providerEventId
      }
    });

    return {
      duplicate: false,
      verified: true,
      matched: false
    };
  }

  const latestTransaction = session.transactions[0];
  const currentSessionStatus = session.status;
  const currentTransactionStatus = latestTransaction?.status ?? null;
  const isAlreadyFinalSuccess =
    currentSessionStatus === 'SUCCESS' ||
    currentTransactionStatus === 'SUCCESS' ||
    currentTransactionStatus === 'CAPTURED' ||
    currentTransactionStatus === 'AUTHORIZED';

  if (
    isAlreadyFinalSuccess &&
    (result.status === 'FAILED' || result.status === 'CANCELLED')
  ) {
    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'PROVIDER_WEBHOOK_STATUS_DOWNGRADE_IGNORED',
      entityType: 'WebhookLog',
      entityId: webhookLog.id,
      ipAddress: input.requestIp ?? null,
      metadata: {
        providerId: provider.id,
        sessionId: session.id,
        attemptedStatus: result.status,
        currentSessionStatus,
        currentTransactionStatus
      }
    });

    return {
      duplicate: false,
      verified: true,
      matched: true,
      sessionId: session.id,
      callbackStatus: 'SUCCESS',
      sessionReference: session.reference
    };
  }

  const mappedSessionStatus =
    result.status === 'SUCCESS'
      ? 'SUCCESS'
      : result.status === 'REFUNDED'
        ? 'SUCCESS'
        : result.status === 'CANCELLED'
          ? 'CANCELLED'
          : result.status === 'FAILED'
            ? 'FAILED'
            : 'PENDING';

  const mappedTransactionStatus: TransactionStatus =
    result.status === 'SUCCESS'
      ? 'SUCCESS'
      : result.status === 'FAILED'
        ? 'FAILED'
        : result.status === 'CANCELLED'
          ? 'CANCELLED'
          : result.status === 'REFUNDED'
            ? 'REFUNDED'
            : 'PENDING';

  if (
    currentSessionStatus === mappedSessionStatus &&
    (currentTransactionStatus === mappedTransactionStatus ||
      (currentTransactionStatus === 'CAPTURED' && mappedTransactionStatus === 'SUCCESS'))
  ) {
    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'PROVIDER_WEBHOOK_IDEMPOTENT_IGNORED',
      entityType: 'WebhookLog',
      entityId: webhookLog.id,
      ipAddress: input.requestIp ?? null,
      metadata: {
        providerId: provider.id,
        sessionId: session.id,
        mappedSessionStatus,
        mappedTransactionStatus
      }
    });

    return {
      duplicate: false,
      verified: true,
      matched: true,
      sessionId: session.id,
      callbackStatus: 'SUCCESS',
      sessionReference: session.reference
    };
  }

  const transactionMetadata = {
    providerWebhook: result.payload,
    processedAt: new Date().toISOString()
  } as Record<string, unknown>;

  await prisma.$transaction(async (tx) => {
    await tx.paymentSession.update({
      where: { id: session.id },
      data: {
        status: mappedSessionStatus,
        providerReference: result.providerReference ?? session.providerReference,
        providerSessionId: result.providerSessionId ?? session.providerSessionId,
        returnUrl: session.returnUrl
      }
    });

    if (latestTransaction) {
      await tx.transaction.update({
        where: { id: latestTransaction.id },
        data: {
          status: mappedTransactionStatus,
          providerReference: result.providerReference ?? latestTransaction.providerReference,
          rawResponse: mergeJson(latestTransaction.rawResponse, transactionMetadata)
        }
      });
    } else {
      await tx.transaction.create({
        data: {
          sessionId: session.id,
          providerId: provider.id,
          amount: session.amount,
          currency: session.currency,
          status: mappedTransactionStatus,
          providerReference: result.providerReference,
          rawResponse: transactionMetadata as Prisma.InputJsonValue
        }
      });
    }
  });

  const callbackResult =
    mappedSessionStatus === 'SUCCESS' || mappedSessionStatus === 'FAILED' || mappedSessionStatus === 'CANCELLED'
      ? await deliverMerchantCallback({
          sessionId: session.id,
          requestIp: input.requestIp
        })
      : { callbackLogId: null, status: 'SKIPPED' as const, attempts: 0 };

  if (mappedSessionStatus === 'SUCCESS' && latestTransaction) {
    const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata) ? (session.metadata as Record<string, unknown>) : null;
    const centralCommunicationResult = await sendCentralCommunicationEvent({
      customer: session.customer,
      metadata: session.metadata ?? null,
      amountMinor: session.amount,
      currency: session.currency,
      paymentRef: latestTransaction.providerReference ?? session.providerReference ?? session.reference,
      bookingRef: typeof metadata?.bookingRef === 'string' ? metadata.bookingRef : session.orderId,
      requestId: webhookLog.id,
      sourceIp: input.requestIp ?? null,
      sessionId: session.id,
      transactionId: latestTransaction.id
    });

    if (centralCommunicationResult.sent) {
      console.info(
        {
          sessionId: session.id,
          bookingRef: session.orderId,
          paymentRef: latestTransaction.providerReference ?? session.providerReference ?? session.reference,
          centralEventId: centralCommunicationResult.eventId,
          deduped: centralCommunicationResult.deduped
        },
        'Central communication event sent'
      );
    } else {
      console.warn(
        {
          sessionId: session.id,
          bookingRef: session.orderId,
          paymentRef: latestTransaction.providerReference ?? session.providerReference ?? session.reference,
          reason: centralCommunicationResult.reason
        },
        'Central communication event skipped or failed'
      );
    }
  }

  await createAuditLog({
    actorType: 'SYSTEM',
    action: 'PROVIDER_WEBHOOK_PROCESSED',
    entityType: 'WebhookLog',
    entityId: webhookLog.id,
    ipAddress: input.requestIp ?? null,
    metadata: {
      providerId: provider.id,
      sessionId: session.id,
      verified: result.isVerified,
      status: result.status,
      callbackStatus: callbackResult.status
    }
  });

  return {
    duplicate: false,
    verified: true,
    matched: true,
    sessionId: session.id,
    callbackStatus: callbackResult.status,
    sessionReference: session.reference
  };
};
