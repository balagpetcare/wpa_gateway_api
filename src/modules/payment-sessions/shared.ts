import { z } from 'zod';
import { sha256Hex, stableJsonStringify } from '../../utils/hmac.js';

const phoneRegex = /^\+?[0-9().\-\s]{7,20}$/;

export const paymentSessionCreateSchema = z.object({
  clientId: z.string().min(1).max(120),
  merchantOrderId: z.string().trim().min(1).max(100),
  amount: z.coerce.number().int().positive(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  customerName: z.string().trim().min(1).max(120),
  customerEmail: z.email().optional().or(z.literal('')).transform((value) => value || undefined),
  customerPhone: z.string().trim().regex(phoneRegex, 'Invalid phone number').optional().or(z.literal('')).transform((value) => value || undefined),
  description: z.string().trim().max(255).optional().or(z.literal('')).transform((value) => value || undefined),
  successUrl: z.url(),
  callbackUrl: z.url(),
  cancelUrl: z.url().optional().or(z.literal('')).transform((value) => value || undefined),
  webhookUrl: z.url().optional().or(z.literal('')).transform((value) => value || undefined),
  metadata: z.record(z.string(), z.unknown()).optional(),
  purpose: z.enum(['DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'SETTLEMENT', 'GENERAL_SALE']).optional(),
  timestamp: z.string().min(1),
  nonce: z.string().min(12).max(128),
  signature: z.string().min(32)
});

export type PaymentSessionCreateInput = z.infer<typeof paymentSessionCreateSchema>;

export const paymentSessionCustomerShape = (input: PaymentSessionCreateInput) => ({
  name: input.customerName,
  email: input.customerEmail,
  phone: input.customerPhone
});

export const paymentSessionFingerprint = (input: {
  merchantId: string;
  environment: string;
  merchantOrderId: string;
  amount: number;
  currency: string;
  customer: Record<string, unknown>;
  successUrl: string;
  callbackUrl: string;
  cancelUrl?: string;
  webhookUrl?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}) =>
  sha256Hex(
    stableJsonStringify({
      merchantId: input.merchantId,
      environment: input.environment,
      merchantOrderId: input.merchantOrderId,
      amount: input.amount,
      currency: input.currency,
      customer: input.customer,
      successUrl: input.successUrl,
      callbackUrl: input.callbackUrl,
      cancelUrl: input.cancelUrl,
      webhookUrl: input.webhookUrl,
      description: input.description,
      metadata: input.metadata ?? null
    })
  );

export const paymentSessionSignaturePayload = (input: {
  clientId: string;
  merchantOrderId: string;
  amount: number;
  currency: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  description?: string;
  successUrl: string;
  callbackUrl: string;
  cancelUrl?: string;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  nonce: string;
}) =>
  stableJsonStringify({
    clientId: input.clientId,
    merchantOrderId: input.merchantOrderId,
    amount: input.amount,
    currency: input.currency,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    description: input.description,
    successUrl: input.successUrl,
    callbackUrl: input.callbackUrl,
    cancelUrl: input.cancelUrl,
    webhookUrl: input.webhookUrl,
    metadata: input.metadata ?? null,
    timestamp: input.timestamp,
    nonce: input.nonce
  });
