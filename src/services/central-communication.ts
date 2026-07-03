import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { createAuditLog } from './audit.js';
import { minorUnitsToSafeNumber } from '../utils/money.js';

const normalizeBangladeshPhone = (value?: string | null) => {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) {
    return `0${digits.slice(3)}`;
  }

  if (digits.length === 11 && digits.startsWith('01')) {
    return digits;
  }

  return value.trim();
};

const safeJsonParse = (value: string) => {
  if (!value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: value.length > 500 ? `${value.slice(0, 500)}...` : value };
  }
};

const mergeJson = (current: unknown, next: Record<string, unknown>): Prisma.InputJsonValue =>
  ({
    ...(typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {}),
    ...next
  }) as Prisma.InputJsonValue;

type CentralCommunicationPayload = {
  event: 'VACCINATION_PAYMENT_CONFIRMED';
  locale: 'bn';
  channels: Array<'sms' | 'email'>;
  recipient: {
    name: string;
    phone?: string;
    email?: string;
  };
  data: {
    bookingRef: string;
    paymentRef: string;
    amount: number;
    currency: string;
    campaignName: string;
    petCount?: number;
    venueName?: string;
    sessionDate?: string;
    sessionTime?: string;
    bookingSlipUrl: string;
    supportPhone: string;
  };
};

export const buildCentralCommunicationRequest = (input: {
  customer: Prisma.JsonValue;
  metadata: Prisma.JsonValue | null;
  amountMinor: bigint;
  currency: string;
  paymentRef?: string | null;
  bookingRef?: string | null;
}) => {
  const customer = input.customer && typeof input.customer === 'object' && !Array.isArray(input.customer) ? (input.customer as Record<string, unknown>) : {};
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? (input.metadata as Record<string, unknown>) : {};

  const name = typeof customer.name === 'string' ? customer.name.trim() : '';
  const email = typeof customer.email === 'string' ? customer.email.trim() : '';
  const phone = normalizeBangladeshPhone(typeof customer.phone === 'string' ? customer.phone : null) ?? '';

  const channels: Array<'sms' | 'email'> = [];
  if (phone) {
    channels.push('sms');
  }
  if (email) {
    channels.push('email');
  }

  const bookingRef = (input.bookingRef ?? (typeof metadata.bookingRef === 'string' ? metadata.bookingRef : undefined) ?? '').trim();
  const paymentRef = (input.paymentRef ?? (typeof metadata.paymentRef === 'string' ? metadata.paymentRef : undefined) ?? '').trim();
  const campaignName = typeof metadata.campaignName === 'string' ? metadata.campaignName.trim() : '';
  const bookingSlipUrl = typeof metadata.bookingSlipUrl === 'string' ? metadata.bookingSlipUrl.trim() : '';

  if (channels.length === 0) {
    return {
      ok: false as const,
      reason: 'NO_RECIPIENT_CHANNELS'
    };
  }

  if (!bookingRef || !paymentRef || !campaignName || !bookingSlipUrl) {
    return {
      ok: false as const,
      reason: 'MISSING_REQUIRED_EVENT_FIELDS'
    };
  }

  let amount: number;
  try {
    amount = minorUnitsToSafeNumber(input.amountMinor);
  } catch {
    return {
      ok: false as const,
      reason: 'AMOUNT_OUT_OF_RANGE'
    };
  }

  const payload: CentralCommunicationPayload = {
    event: 'VACCINATION_PAYMENT_CONFIRMED',
    locale: 'bn',
    channels,
    recipient: {
      name: name || bookingRef,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {})
    },
    data: {
      bookingRef,
      paymentRef,
      amount,
      currency: input.currency,
      campaignName,
      petCount: typeof metadata.petCount === 'number' ? metadata.petCount : typeof metadata.petCount === 'string' ? Number(metadata.petCount) : undefined,
      venueName: typeof metadata.venueName === 'string' ? metadata.venueName.trim() : undefined,
      sessionDate: typeof metadata.sessionDate === 'string' ? metadata.sessionDate.trim() : undefined,
      sessionTime: typeof metadata.sessionTime === 'string' ? metadata.sessionTime.trim() : undefined,
      bookingSlipUrl,
      supportPhone: typeof metadata.supportPhone === 'string' && metadata.supportPhone.trim().length > 0 ? metadata.supportPhone.trim() : '01701022274'
    }
  };

  return {
    ok: true as const,
    payload,
    idempotencyKey: `payment:${paymentRef}:booking:${bookingRef}`,
    normalizedRecipient: {
      name: payload.recipient.name,
      phone: phone || undefined,
      email: email || undefined
    }
  };
};

export const sendCentralCommunicationEvent = async (input: {
  customer: Prisma.JsonValue;
  metadata: Prisma.JsonValue | null;
  amountMinor: bigint;
  currency: string;
  paymentRef?: string | null;
  bookingRef?: string | null;
  requestId?: string;
  sourceIp?: string | null;
  sessionId: string;
  transactionId: string;
}) => {
  if (!env.CENTRAL_COMMUNICATION_API_URL || !env.CENTRAL_CLIENT_ID || !env.CENTRAL_SERVICE_API_KEY) {
    return {
      sent: false as const,
      deduped: false,
      reason: 'CENTRAL_COMMUNICATION_NOT_CONFIGURED'
    };
  }

  const buildResult = buildCentralCommunicationRequest(input);
  if (!buildResult.ok) {
    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'CENTRAL_COMMUNICATION_EVENT_SKIPPED',
      entityType: 'PaymentSession',
      entityId: input.sessionId,
      ipAddress: input.sourceIp ?? null,
      metadata: {
        reason: buildResult.reason,
        sessionId: input.sessionId,
        transactionId: input.transactionId
      }
    });

    return {
      sent: false as const,
      deduped: false,
      reason: buildResult.reason
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(env.CENTRAL_COMMUNICATION_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CENTRAL_SERVICE_API_KEY}`,
        'X-Client-Id': env.CENTRAL_CLIENT_ID,
        'Idempotency-Key': buildResult.idempotencyKey,
        ...(input.requestId ? { 'X-Request-Id': input.requestId } : {})
      },
      body: JSON.stringify(buildResult.payload),
      signal: controller.signal
    });

    const responseText = await response.text();
    const parsed = safeJsonParse(responseText);
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const responseData = typeof data.data === 'object' && data.data !== null && !Array.isArray(data.data) ? (data.data as Record<string, unknown>) : null;

    const eventId =
      typeof data.eventId === 'string'
        ? data.eventId
        : responseData && typeof responseData.eventId === 'string'
          ? responseData.eventId
          : null;

    const deduped =
      response.ok &&
      (data.deduped === true ||
        data.status === 'ALREADY_ACCEPTED' ||
        (responseData?.deduped === true));

    const transaction = await prisma.transaction.findUnique({
      where: { id: input.transactionId },
      select: { rawResponse: true }
    });

    await prisma.transaction.update({
      where: { id: input.transactionId },
      data: {
        rawResponse: mergeJson(transaction?.rawResponse ?? null, {
          centralCommunication: {
            eventId,
            deduped,
            status: response.ok ? 'QUEUED_OR_SENT' : 'FAILED'
          }
        })
      }
    });

    await createAuditLog({
      actorType: 'SYSTEM',
      action: response.ok ? 'CENTRAL_COMMUNICATION_EVENT_TRIGGERED' : 'CENTRAL_COMMUNICATION_EVENT_FAILED',
      entityType: 'PaymentSession',
      entityId: input.sessionId,
      ipAddress: input.sourceIp ?? null,
      metadata: {
        bookingRef: buildResult.payload.data.bookingRef,
        paymentRef: buildResult.payload.data.paymentRef,
        eventId,
        deduped,
        statusCode: response.status
      }
    });

    return {
      sent: response.ok,
      deduped,
      eventId,
      statusCode: response.status,
      response: parsed
    };
  } catch (error) {
    await createAuditLog({
      actorType: 'SYSTEM',
      action: 'CENTRAL_COMMUNICATION_EVENT_FAILED',
      entityType: 'PaymentSession',
      entityId: input.sessionId,
      ipAddress: input.sourceIp ?? null,
      metadata: {
        bookingRef: buildResult.payload.data.bookingRef,
        paymentRef: buildResult.payload.data.paymentRef,
        error: error instanceof Error ? error.message : 'Communication event request failed'
      }
    });

    return {
      sent: false as const,
      deduped: false,
      eventId: null,
      reason: 'REQUEST_FAILED'
    };
  } finally {
    clearTimeout(timeout);
  }
};
