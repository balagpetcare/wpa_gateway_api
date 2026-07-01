import type { Prisma } from '@prisma/client';
import { DeliveryStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { sha256Hex, signHmacSha256, stableJsonStringify } from '../utils/hmac.js';
import { createAuditLog } from './audit.js';
import { getMerchantCallbackSecret } from './merchant-secrets.js';
import { redactSensitiveData } from '../utils/redaction.js';

const mapSessionStatusToEvent = (status: string) => {
  switch (status) {
    case 'SUCCESS':
      return 'payment.succeeded';
    case 'FAILED':
      return 'payment.failed';
    case 'CANCELLED':
      return 'payment.cancelled';
    default:
      return 'payment.pending';
  }
};

const buildCallbackDispatch = async (sessionId: string) => {
  const session = await prisma.paymentSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      merchant: true,
      provider: true,
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  const latestTransaction = session.transactions[0];
  const callbackSecret = await getMerchantCallbackSecret(session.merchantId);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(12).toString('hex');
  const callbackTarget = session.webhookUrl || session.callbackUrl;
  const payload = {
    event: mapSessionStatusToEvent(session.status),
    merchantOrderId: session.orderId,
    gatewayReference: session.reference,
    transactionReference: latestTransaction?.providerReference ?? session.providerReference,
    amount: Number(session.amount),
    currency: session.currency,
    status: session.status,
    paidAt: session.status === 'SUCCESS' ? session.updatedAt.toISOString() : null,
    timestamp,
    nonce
  };
  const body = stableJsonStringify(payload);
  const signature = signHmacSha256(body, callbackSecret);
  const payloadHash = sha256Hex(body);

  return {
    session,
    callbackTarget,
    payload,
    body,
    payloadHash,
    headers: {
      'content-type': 'application/json',
      'x-gateway-timestamp': String(timestamp),
      'x-gateway-nonce': nonce,
      'x-gateway-event': payload.event,
      'x-gateway-signature': signature
    }
  };
};

const safeParseResponseBody = (text: string) => {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      text: text.length > 500 ? `${text.slice(0, 500)}...` : text
    };
  }
};

const computeNextAttemptAt = (attempts: number, baseDelaySeconds: number, maxAttempts: number) => {
  if (attempts >= maxAttempts) {
    return null;
  }

  const multiplier = Math.min(2 ** Math.max(attempts - 1, 0), 16);
  return new Date(Date.now() + baseDelaySeconds * multiplier * 1000);
};

export const attemptCallbackDelivery = async (
  callbackLogId: string,
  options?: {
    baseDelaySeconds?: number;
    maxAttempts?: number;
    requestIp?: string;
  }
) => {
  const baseDelaySeconds = options?.baseDelaySeconds ?? 900;
  const maxAttempts = options?.maxAttempts ?? 5;

  const callbackLog = await prisma.callbackLog.findUnique({
    where: { id: callbackLogId },
    select: {
      id: true,
      sessionId: true,
      status: true,
      attempts: true
    }
  });

  if (!callbackLog) {
    throw new Error(`Callback log ${callbackLogId} not found`);
  }

  if (callbackLog.status === DeliveryStatus.SUCCESS) {
    return { callbackLogId, status: DeliveryStatus.SUCCESS, attempts: callbackLog.attempts };
  }

  if (callbackLog.attempts >= maxAttempts) {
    return { callbackLogId, status: callbackLog.status, attempts: callbackLog.attempts };
  }

  const dispatch = await buildCallbackDispatch(callbackLog.sessionId);
  const nextAttemptCount = callbackLog.attempts + 1;

  const processing = await prisma.callbackLog.updateMany({
    where: {
      id: callbackLogId,
      status: { in: [DeliveryStatus.PENDING, DeliveryStatus.FAILED] },
      attempts: callbackLog.attempts
    },
    data: {
      callbackUrl: dispatch.callbackTarget,
      requestBody: {
        event: dispatch.payload.event,
        payload: dispatch.payload,
        payloadHash: dispatch.payloadHash,
        headers: dispatch.headers
      } as Prisma.InputJsonValue,
      attempts: nextAttemptCount,
      status: DeliveryStatus.PROCESSING,
      lastAttemptAt: new Date()
    }
  });

  if (processing.count === 0) {
    const current = await prisma.callbackLog.findUniqueOrThrow({
      where: { id: callbackLogId },
      select: { status: true, attempts: true }
    });
    return { callbackLogId, status: current.status, attempts: current.attempts };
  }

  let finalStatus: 'SUCCESS' | 'FAILED' = 'FAILED';
  let lastResponseCode: number | null = null;
  let lastResponseBody: unknown = null;

  try {
    const response = await fetch(dispatch.callbackTarget, {
      method: 'POST',
      headers: dispatch.headers,
      body: dispatch.body
    });

    lastResponseCode = response.status;
    lastResponseBody = safeParseResponseBody(await response.text());

    if (response.ok) {
      finalStatus = 'SUCCESS';
    }
  } catch (error) {
    lastResponseBody = {
      message: error instanceof Error ? error.message : 'Callback delivery failed'
    };
  }

  const redactedRequestPreview = redactSensitiveData({
    callbackUrl: dispatch.callbackTarget,
    headers: dispatch.headers,
    payload: dispatch.payload
  });
  const redactedResponsePreview = redactSensitiveData(lastResponseBody);

  await prisma.callbackLog.update({
    where: { id: callbackLogId },
    data: {
      responseCode: lastResponseCode,
      responseBody: (lastResponseBody ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      status: finalStatus,
      attempts: nextAttemptCount,
      nextAttemptAt: finalStatus === 'FAILED' ? computeNextAttemptAt(nextAttemptCount, baseDelaySeconds, maxAttempts) : null
    }
  });

  await createAuditLog({
    actorType: 'SYSTEM',
    action: 'MERCHANT_CALLBACK_DELIVERED',
    entityType: 'CallbackLog',
    entityId: callbackLogId,
    ipAddress: options?.requestIp ?? null,
    metadata: {
      sessionId: dispatch.session.id,
      amount: dispatch.session.amount.toString(),
      status: finalStatus,
      attempts: nextAttemptCount,
      responseCode: lastResponseCode
    }
  });

  await createAuditLog({
    actorType: 'SYSTEM',
    action: 'MERCHANT_CALLBACK_ATTEMPT_RECORDED',
    entityType: 'CallbackLog',
    entityId: callbackLogId,
    ipAddress: options?.requestIp ?? null,
    metadata: {
      sessionId: dispatch.session.id,
      attempt: nextAttemptCount,
      finalStatus,
      responseCode: lastResponseCode,
      requestPreview: redactedRequestPreview as Record<string, unknown>,
      responsePreview:
        redactedResponsePreview && typeof redactedResponsePreview === 'object' && !Array.isArray(redactedResponsePreview)
          ? (redactedResponsePreview as Record<string, unknown>)
          : { value: redactedResponsePreview ?? null }
    }
  });

  return { callbackLogId, status: finalStatus, attempts: nextAttemptCount };
};

export const deliverMerchantCallback = async (input: {
  sessionId: string;
  requestIp?: string;
}) => {
  const dispatch = await buildCallbackDispatch(input.sessionId);

  const callbackLog = await prisma.callbackLog.create({
    data: {
      sessionId: dispatch.session.id,
      callbackUrl: dispatch.callbackTarget,
      requestBody: {
        event: dispatch.payload.event,
        payload: dispatch.payload,
        payloadHash: dispatch.payloadHash,
        headers: dispatch.headers
      } as Prisma.InputJsonValue,
      status: DeliveryStatus.PENDING,
      attempts: 0
    }
  });

  const result = await attemptCallbackDelivery(callbackLog.id, {
    baseDelaySeconds: 900,
    maxAttempts: 5,
    requestIp: input.requestIp
  });

  return result;
};
