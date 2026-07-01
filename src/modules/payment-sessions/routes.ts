import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PaymentSession, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { requireMerchantHmac } from '../../middleware/merchant-hmac.js';
import { enforceMerchantDomain } from '../../middleware/domain-check.js';
import { createAuditLog } from '../../services/audit.js';
import { listSupportedProviders, selectActiveProvider } from '../../services/provider-selection.js';
import { verifyMerchantInitiationRequest } from '../../services/merchant-auth.js';
import { getDecryptedProviderCredentials } from '../../services/provider-credentials.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { ApiError } from '../../utils/errors.js';
import { minorUnitsToDecimalString, minorUnitsToSafeNumber, truncateDecimalStringToBigInt } from '../../utils/money.js';
import { GatewayRoutingService } from '../../services/gateway-routing.js';
import { buildGatewayUrl, resolveGatewayBaseUrl } from '../../utils/public-url.js';
import { validateBody, validateParams } from '../../utils/validation.js';
import { getProviderAdapter } from '../../providers/index.js';
import { assertProviderReadyForPayments } from '../../providers/readiness.js';
import {
  paymentSessionCreateSchema,
  paymentSessionCustomerShape,
  paymentSessionFingerprint,
  paymentSessionSignaturePayload
} from './shared.js';

const checkoutPaySchema = z.object({
  providerCode: z.string().min(1),
  paymentMethod: z.string().trim().min(1).max(100).optional(),
  customerConfirmation: z.record(z.string(), z.unknown()).optional()
});

const sessionIdSchema = z.object({
  id: z.string().min(1)
});

const toJsonObject = (value: Record<string, unknown>): Prisma.InputJsonValue => {
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  return Object.fromEntries(entries) as Prisma.InputJsonObject;
};

const getHostname = (value: string) => new URL(value).hostname.toLowerCase();

const readAllowedHosts = async (merchantId: string, environment: 'SANDBOX' | 'PRODUCTION') => {
  const domains = await prisma.merchantDomain.findMany({
    where: {
      merchantId,
      environment,
      status: 'ACTIVE'
    },
    select: {
      normalizedOrigin: true
    }
  });

  return new Set(domains.map((domain) => domain.normalizedOrigin.toLowerCase()));
};

const ensureCallbackTargetsAllowed = async (input: {
  merchantId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  callbackUrl: string;
  webhookUrl?: string;
}) => {
  const allowedHosts = await readAllowedHosts(input.merchantId, input.environment);
  if (allowedHosts.size === 0) {
    throw new ApiError(403, 'DOMAIN_NOT_ALLOWED', 'Merchant has no allowed domains configured');
  }

  for (const target of [input.callbackUrl, input.webhookUrl].filter((value): value is string => typeof value === 'string')) {
    const hostname = getHostname(target);
    if (!allowedHosts.has(hostname)) {
      throw new ApiError(403, 'DOMAIN_NOT_ALLOWED', 'Callback or webhook URL domain is not in allowlist');
    }
  }
};

const buildPublicPaymentUrl = (reference: string) => `/checkout/${reference}`;

const generateReference = () => `wps_${randomBytes(16).toString('hex')}`;

const buildCheckoutBaseUrl = (request: FastifyRequest) => {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
  return origin ? origin.replace(/\/+$/, '') : resolveGatewayBaseUrl(request);
};

const sanitizeProviderError = (error: unknown) => {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode
    };
  }

  if (error instanceof Error) {
    return {
      code: 'PROVIDER_ERROR' as const,
      message: error.message,
      statusCode: 502
    };
  }

  return {
    code: 'PROVIDER_ERROR' as const,
    message: 'Payment provider initiation failed',
    statusCode: 502
  };
};

const buildPublicProviders = (providers: Array<{
  name: string;
  displayName: string;
  isActive: boolean;
  environment?: string;
  supportedCurrencies: unknown;
  supportedCountries: unknown;
  priority: number;
}>, environment: 'SANDBOX' | 'PRODUCTION') =>
  providers.map((provider) => ({
    providerCode: provider.name,
    providerDisplayName: provider.displayName,
    logoUrl: null,
    supportedMethods: null,
    environment,
    status: provider.isActive ? 'ACTIVE' : 'INACTIVE'
  }));

type PaymentSessionRecord = {
  id: string;
  reference: string;
  status: string;
  amount: bigint;
  currency: string;
  orderId: string;
  requestHash: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  description: string | null;
  expiresAt: Date | null;
};

const mapSessionResponse = (session: {
  id: string;
  reference: string;
  status: string;
  amount: bigint;
  currency: string;
  orderId: string;
  expiresAt: Date | null;
}) => ({
  id: session.id,
  reference: session.reference,
  status: session.status,
  amount: session.amount.toString(),
  currency: session.currency,
  merchantOrderId: session.orderId,
  paymentUrl: buildPublicPaymentUrl(session.reference),
  expiresAt: session.expiresAt
});

const serializeMinorAmount = (amount: bigint) => amount.toString();

const buildProviderAmountInput = (amountMinor: bigint) => {
  const amountMinorString = amountMinor.toString();
  const amountDecimal = minorUnitsToDecimalString(amountMinorString, 2);

  try {
    return {
      amount: minorUnitsToSafeNumber(amountMinorString),
      amountMinor: amountMinorString,
      amountDecimal
    };
  } catch {
    return {
      amount: undefined,
      amountMinor: amountMinorString,
      amountDecimal
    };
  }
};

const isSessionOpen = (status: string, expiresAt: Date | null) =>
  status === 'PENDING' && (!expiresAt || expiresAt.getTime() > Date.now());

const readCustomerString = (customer: Prisma.JsonValue, key: 'name' | 'email' | 'phone') => {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    return '';
  }

  const value = (customer as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

const loadPublicSession = async (reference: string) => {
  const session = await prisma.paymentSession.findUnique({
    where: { reference },
    include: {
      merchant: { select: { id: true, name: true, status: true } },
      provider: { select: { id: true, name: true, displayName: true, isActive: true, supportedCurrencies: true, supportedCountries: true, priority: true } },
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          providerId: true,
          providerReference: true,
          createdAt: true,
          updatedAt: true
        }
      }
    }
  });

  if (!session || session.merchant.status !== 'ACTIVE' || !isSessionOpen(session.status, session.expiresAt)) {
    return null;
  }

  // Resolve checkout options based on routing rules
  const metadataVal = session.metadata || {};
  const countryCodeVal = String((metadataVal as any).customerCountry || (metadataVal as any).country || 'US');
  let filteredProviders: Array<{ id: string; name: string; displayName: string; isActive: boolean; priority: number; supportedCurrencies: unknown; supportedCountries: unknown }> = [];

  try {
    const route = await GatewayRoutingService.resolveRoute({
      merchantId: session.merchantId,
      countryCode: countryCodeVal,
      currencyCode: session.currency,
      purpose: session.purpose as any,
      environment: session.environment,
      amount: session.amount
    });

    if (route.provider) {
      filteredProviders = [{
        id: route.provider.id,
        name: route.provider.name,
        displayName: route.provider.displayName,
        isActive: route.provider.isActive,
        priority: 100,
        supportedCurrencies: [session.currency],
        supportedCountries: [countryCodeVal]
      }];
    }
  } catch (err) {
    // Fall back to active providers if routing check fails
    const active = await prisma.paymentProvider.findMany({
      where: {
        id: session.providerId,
        isActive: true
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        isActive: true,
        priority: true,
        supportedCurrencies: true,
        supportedCountries: true
      }
    });
    filteredProviders = active;
  }

  return {
    session,
    providers: filteredProviders
  };
};

export const paymentSessionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/checkout/:reference',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.ip
        }
      },
      preValidation: validateParams(z.object({ reference: z.string().min(1) }))
    },
    async (request, reply) => {
      const { reference } = request.params as { reference: string };
      const result = await loadPublicSession(reference);

      if (!result) {
        return reply.notFound('Checkout session not found');
      }

      const { session, providers } = result;
      const customer = session.customer as Record<string, unknown> | null;

      return {
        data: {
          reference: session.reference,
          merchantName: session.merchant.name,
          amount: serializeMinorAmount(session.amount),
          currency: session.currency,
          merchantOrderId: session.orderId,
          description: session.description,
          customer: customer
            ? {
                name: typeof customer.name === 'string' ? customer.name : null,
                email: typeof customer.email === 'string' ? customer.email : null,
                phone: typeof customer.phone === 'string' ? customer.phone : null
              }
            : null,
          status: session.status,
          expiresAt: session.expiresAt,
          providers: buildPublicProviders(providers, session.environment)
        }
      };
    }
  );

  app.get(
    '/api/v1/checkout/:reference/status',
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.ip
        }
      },
      preValidation: validateParams(z.object({ reference: z.string().min(1) }))
    },
    async (request, reply) => {
      const { reference } = request.params as { reference: string };
      const session = await prisma.paymentSession.findUnique({
        where: { reference },
        include: {
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });

      if (!session) {
        return reply.notFound('Checkout session not found');
      }

      const latestTransaction = session.transactions[0] ?? null;

      return {
        data: {
          reference: session.reference,
          status: session.status,
          transactionStatus: latestTransaction?.status ?? null,
          amount: serializeMinorAmount(session.amount),
          currency: session.currency,
          merchantOrderId: session.orderId,
          updatedAt: session.updatedAt
        }
      };
    }
  );

  app.post(
    '/api/v1/checkout/:reference/pay',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.ip
        }
      },
      preValidation: [validateParams(z.object({ reference: z.string().min(1) })), validateBody(checkoutPaySchema)]
    },
    async (request) => {
      const { reference } = request.params as { reference: string };
      const payload = request.body as z.infer<typeof checkoutPaySchema>;
      const session = await prisma.paymentSession.findUnique({
        where: { reference },
        include: {
          merchant: { select: { id: true, name: true, status: true, environment: true, contactEmail: true, contactPhone: true } },
          provider: { select: { id: true, name: true, displayName: true, isActive: true, supportedCurrencies: true, supportedCountries: true } },
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      });

      if (!session || session.merchant.status !== 'ACTIVE') {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'Checkout session not found');
      }

      if (!isSessionOpen(session.status, session.expiresAt)) {
        throw new ApiError(410, 'SESSION_NOT_FOUND', 'Checkout session is no longer available');
      }

      const providers = await listSupportedProviders({
        merchantId: session.merchantId,
        currency: session.currency
      });

      const selectedProvider = providers.find((provider) => provider.name.toUpperCase() === payload.providerCode.toUpperCase());
      if (!selectedProvider) {
        throw new ApiError(422, 'PROVIDER_NOT_CONFIGURED', 'Selected payment provider is not available for this checkout session');
      }

      const latestTransaction = session.transactions[0] ?? null;
      if (latestTransaction && latestTransaction.status !== 'PENDING') {
        throw new ApiError(409, 'CONFLICT', 'Payment session already has a completed payment attempt');
      }
      if (latestTransaction && latestTransaction.providerId !== selectedProvider.id) {
        throw new ApiError(409, 'CONFLICT', 'Payment provider cannot be changed after a payment attempt has started');
      }

      assertProviderReadyForPayments(selectedProvider);
      const adapter = getProviderAdapter(selectedProvider);

      const transaction = await prisma.$transaction(async (tx) => {
        await tx.paymentSession.update({
          where: { id: session.id },
          data: {
            providerId: selectedProvider.id
          }
        });

        if (latestTransaction) {
          return tx.transaction.update({
            where: { id: latestTransaction.id },
            data: {
              status: 'PENDING',
              providerId: selectedProvider.id,
              rawResponse: {
                ...(typeof latestTransaction.rawResponse === 'object' && latestTransaction.rawResponse !== null
                  ? (latestTransaction.rawResponse as Record<string, unknown>)
                  : {}),
                initiatedAt: new Date().toISOString(),
                providerCode: selectedProvider.name,
                paymentMethod: payload.paymentMethod ?? null,
                customerConfirmation: payload.customerConfirmation ?? null
              } as Prisma.InputJsonValue
            }
          });
        }

        return tx.transaction.create({
          data: {
            sessionId: session.id,
            providerId: selectedProvider.id,
            amount: session.amount,
            currency: session.currency,
            status: 'PENDING',
            rawResponse: {
              initiatedAt: new Date().toISOString(),
              providerCode: selectedProvider.name,
              paymentMethod: payload.paymentMethod ?? null,
              customerConfirmation: payload.customerConfirmation ?? null
            } as Prisma.InputJsonValue
          }
        });
      });

      const credentials = await getDecryptedProviderCredentials({
        providerId: selectedProvider.id,
        merchantId: session.merchantId
      }).catch(() => ({}));

      if (Object.keys(credentials).length === 0) {
        throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Payment provider is not configured yet. Please contact support.');
      }

      const successUrl = session.successUrl || buildPublicPaymentUrl(reference);
      const cancelUrl = session.cancelUrl || successUrl;
      const callbackUrl = session.callbackUrl || successUrl;
      const checkoutBaseUrl = buildCheckoutBaseUrl(request);
      const hostedCheckoutReturnUrl = `${checkoutBaseUrl}/checkout/${reference}`;
      const providerReturnBase = `/api/v1/providers/${selectedProvider.name.toLowerCase()}`;
      const providerSuccessUrl = buildGatewayUrl(request, `${providerReturnBase}/success?reference=${encodeURIComponent(reference)}`);
      const providerFailUrl = buildGatewayUrl(request, `${providerReturnBase}/fail?reference=${encodeURIComponent(reference)}`);
      const providerCancelUrl = buildGatewayUrl(request, `${providerReturnBase}/cancel?reference=${encodeURIComponent(reference)}`);
      const providerCallbackUrl = buildGatewayUrl(request, `${providerReturnBase}/callback?reference=${encodeURIComponent(reference)}`);
      const usesProviderManagedRedirect =
        selectedProvider.name === 'EPS' || selectedProvider.name === 'BKASH' || selectedProvider.name === 'NAGAD' || selectedProvider.name === 'SSLCOMMERZ';

      const providerAmount = buildProviderAmountInput(session.amount);

      let paymentUrlResult;
      try {
        paymentUrlResult = await adapter.createPayment({
          sessionId: session.id,
          merchantId: session.merchantId,
          orderId: session.orderId,
          amount: providerAmount.amount,
          amountMinor: providerAmount.amountMinor,
          amountDecimal: providerAmount.amountDecimal,
          currency: session.currency,
          providerEnvironment: session.environment,
          purpose: session.purpose,
          customer: {
            name: readCustomerString(session.customer, 'name'),
            email: readCustomerString(session.customer, 'email'),
            phone: readCustomerString(session.customer, 'phone') || undefined
          },
          merchantContactEmail: session.merchant.contactEmail,
          merchantContactPhone: session.merchant.contactPhone ?? undefined,
          successUrl: usesProviderManagedRedirect ? providerSuccessUrl : successUrl,
          cancelUrl:
            selectedProvider.name === 'SSLCOMMERZ'
              ? providerFailUrl
              : usesProviderManagedRedirect
                ? providerFailUrl
                : cancelUrl,
          callbackUrl:
            selectedProvider.name === 'BKASH'
              ? providerCallbackUrl
              : selectedProvider.name === 'NAGAD'
                ? providerCallbackUrl
              : selectedProvider.name === 'SSLCOMMERZ'
                ? providerCallbackUrl
              : selectedProvider.name === 'EPS'
                ? providerCancelUrl
                : callbackUrl,
          credentials
        });
      } catch (error) {
        const providerError = sanitizeProviderError(error);

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            rawResponse: {
              ...(typeof transaction.rawResponse === 'object' && transaction.rawResponse !== null
                ? (transaction.rawResponse as Record<string, unknown>)
                : {}),
              providerError: {
                code: providerError.code,
                message: providerError.message
              },
              failedAt: new Date().toISOString(),
              providerCode: selectedProvider.name
            } as Prisma.InputJsonValue
          }
        });

        await createAuditLog({
          actorType: 'SYSTEM',
          actorId: null,
          action:
            providerError.code === 'PROVIDER_TIMEOUT'
              ? 'CHECKOUT_PROVIDER_TIMEOUT'
              : providerError.code === 'PROVIDER_UNAVAILABLE'
                ? 'CHECKOUT_PROVIDER_UNAVAILABLE'
                : 'CHECKOUT_PROVIDER_INIT_FAILED',
          entityType: 'PaymentSession',
          entityId: session.id,
          ipAddress: request.ip,
          metadata: {
            reference,
            providerCode: selectedProvider.name,
            errorCode: providerError.code,
            errorMessage: providerError.message
          }
        });

        throw new ApiError(providerError.statusCode, providerError.code, providerError.message);
      }

      await prisma.$transaction(async (tx) => {
        await tx.paymentSession.update({
          where: { id: session.id },
          data: {
            providerId: selectedProvider.id,
            providerSessionId: paymentUrlResult.providerSessionId,
            providerReference: paymentUrlResult.providerReference,
            returnUrl: hostedCheckoutReturnUrl
          }
        });

        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            rawResponse: paymentUrlResult.rawResponse as Prisma.InputJsonValue
          }
        });
      });

      await createAuditLog({
        actorType: 'SYSTEM',
        actorId: null,
        action: 'CHECKOUT_PROVIDER_INITIATED',
        entityType: 'PaymentSession',
        entityId: session.id,
        ipAddress: request.ip,
        metadata: {
          reference,
          providerCode: selectedProvider.name,
          providerReference: paymentUrlResult.providerReference
        }
      });

      const providerPaymentUrl = (paymentUrlResult.rawResponse as Record<string, unknown>).paymentUrl;
      return {
        data: {
          paymentUrl: typeof providerPaymentUrl === 'string' ? providerPaymentUrl : buildPublicPaymentUrl(reference),
          transaction: {
            id: transaction.id,
            reference: paymentUrlResult.providerReference,
            status: 'PENDING',
            providerCode: selectedProvider.name
          },
          session: {
            reference: session.reference,
            status: 'PENDING',
            amount: serializeMinorAmount(session.amount),
            currency: session.currency,
            merchantOrderId: session.orderId
          }
        }
      };
    }
  );

  app.post(
    '/api/v1/payment-sessions',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.ip
        }
      },
      preValidation: validateBody(paymentSessionCreateSchema)
    },
    async (request, reply) => {
      const payload = request.body as z.infer<typeof paymentSessionCreateSchema>;
      const customer = paymentSessionCustomerShape(payload);
      const signaturePayload = paymentSessionSignaturePayload(payload);
      const merchantOrderId = payload.merchantOrderId;
      const auditContext = {
        clientId: payload.clientId,
        merchantOrderId,
        amount: payload.amount,
        currency: payload.currency
      };

      try {
        const verified = await verifyMerchantInitiationRequest(request, {
          clientId: payload.clientId,
          timestamp: payload.timestamp,
          signature: payload.signature,
          nonce: payload.nonce,
          bodyForSignature: signaturePayload
        });

        const environment = verified.apiKey.environment as 'SANDBOX' | 'PRODUCTION';
        await enforceMerchantDomain(request);
        await ensureCallbackTargetsAllowed({
          merchantId: verified.merchant.id,
          environment,
          callbackUrl: payload.callbackUrl,
          webhookUrl: payload.webhookUrl
        });

        let provider: Awaited<ReturnType<typeof selectActiveProvider>>;
        try {
          provider = await selectActiveProvider({
            merchantId: verified.merchant.id,
            currency: payload.currency
          });
        } catch (error) {
          if (error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE') {
            const activeProviderCount = await prisma.paymentProvider.count({
              where: { isActive: true }
            });
            if (activeProviderCount === 0) {
              throw error;
            }
          }
          throw new ApiError(422, 'UNSUPPORTED_CURRENCY', 'Unsupported currency for merchant payment session');
        }

        const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;

        const requestHash = paymentSessionFingerprint({
          merchantId: verified.merchant.id,
          environment,
          merchantOrderId,
          amount: payload.amount,
          currency: payload.currency,
          customer,
          successUrl: payload.successUrl,
          callbackUrl: payload.callbackUrl,
          cancelUrl: payload.cancelUrl,
          webhookUrl: payload.webhookUrl,
          description: payload.description,
          metadata: payload.metadata
        });

        const existingSession = (await prisma.paymentSession.findFirst({
          where: {
            merchantId: verified.merchant.id,
            environment,
            orderId: merchantOrderId
          },
          select: {
            id: true,
            reference: true,
            status: true,
            amount: true,
            currency: true,
            orderId: true,
            requestHash: true,
            environment: true,
            description: true,
            expiresAt: true
          }
        })) as PaymentSessionRecord | null;

        if (existingSession) {
          if (existingSession.requestHash === requestHash && existingSession.status === 'PENDING') {
            request.log.info(
              { ...auditContext, sessionId: existingSession.id, reference: existingSession.reference },
              'Returning existing pending payment session'
            );
            return reply.status(200).send({
              data: mapSessionResponse(existingSession)
            });
          }

          request.log.warn(
            { ...auditContext, sessionId: existingSession.id, existingStatus: existingSession.status },
            'Duplicate merchant order attempt rejected'
          );

          throw new ApiError(
            409,
            'CONFLICT',
            existingSession.requestHash === requestHash
              ? 'Duplicate merchant order already exists in a non-pending state'
              : 'Duplicate merchantOrderId with different payment details'
          );
        }

        // Resolve the route and fee rules using the GatewayRoutingService
        let routeResult;
        let targetPurpose: any = payload.purpose || 'GENERAL_SALE'; // Default to GENERAL_SALE if missing
        
        try {
          const metaPurpose = (payload.metadata as any)?.purpose || (payload.metadata as any)?.PaymentPurpose || payload.description;
          if (!payload.purpose && metaPurpose && typeof metaPurpose === 'string') {
            const cleanMeta = metaPurpose.toUpperCase();
            if (['DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'SETTLEMENT', 'GENERAL_SALE', 'ALL_PURPOSES'].includes(cleanMeta)) {
              targetPurpose = cleanMeta as any;
            }
          }

          const metadataVal = payload.metadata || {};
          const countryCodeVal = String((metadataVal as any).customerCountry || (metadataVal as any).country || 'US');

          routeResult = await GatewayRoutingService.resolveRoute({
            merchantId: verified.merchant.id,
            countryCode: countryCodeVal,
            currencyCode: payload.currency,
            purpose: targetPurpose,
            environment,
            amount: BigInt(Math.trunc(payload.amount))
          });
        } catch (error) {
          // Fall back to basic selection if resolveRoute fails
          const selectProvider = await selectActiveProvider({
            merchantId: verified.merchant.id,
            currency: payload.currency
          });
          routeResult = {
            provider: selectProvider,
            credentialProfile: null,
            feeRule: null,
            feeCalculation: null,
            settlementProfile: null,
            reason: null
          };
        }

        const resolvedProviderId = routeResult.provider.id;
        const baseAmount = BigInt(Math.trunc(payload.amount));
        const gatewayFee = routeResult.feeCalculation ? truncateDecimalStringToBigInt(routeResult.feeCalculation.totalFee) : 0n;
        const platformFee = 0n; // default platformFee

        // Compute amounts according to feeBearer logic
        let totalPayableAmount = baseAmount;
        let netSettlementAmount = baseAmount;
        const feeBearerVal: any = routeResult.feeCalculation?.feeBearer || 'MERCHANT';

        if (feeBearerVal === 'CUSTOMER') {
          totalPayableAmount = baseAmount + gatewayFee + platformFee;
          netSettlementAmount = baseAmount;
        } else if (feeBearerVal === 'MERCHANT' || feeBearerVal === 'SHARED') {
          totalPayableAmount = baseAmount;
          netSettlementAmount = baseAmount - gatewayFee - platformFee;
        } else if (feeBearerVal === 'PLATFORM') {
          totalPayableAmount = baseAmount;
          netSettlementAmount = baseAmount;
        }

        const created = await prisma.$transaction(async (tx) => {
          const reference = generateReference();
          const session = await tx.paymentSession.create({
            data: {
              reference,
              merchantId: verified.merchant.id,
              merchantApiKeyId: verified.apiKey.id,
              providerId: resolvedProviderId,
              orderId: merchantOrderId,
              environment,
              amount: baseAmount,
              currency: payload.currency,
              purpose: targetPurpose, // Requires a valid purpose
              description: payload.description,
              customer: toJsonObject({
                name: payload.customerName,
                email: payload.customerEmail,
                phone: payload.customerPhone
              }),
              successUrl: payload.successUrl,
              cancelUrl: payload.cancelUrl,
              callbackUrl: payload.callbackUrl,
              webhookUrl: payload.webhookUrl,
              returnUrl: payload.successUrl,
              metadata: payload.metadata as Prisma.InputJsonValue | undefined,
              requestHash,
              requestIp: request.ip,
              requestUserAgent: userAgent ?? null,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000),
              baseAmount,
              gatewayFee,
              platformFee,
              totalPayableAmount,
              feeBearer: feeBearerVal,
              netSettlementAmount,
              credentialProfileId: routeResult.credentialProfile?.id || null,
              settlementProfileId: routeResult.settlementProfile?.id || null,
              routingFallbackLevel: routeResult.reason || null
            }
          });

          await tx.transaction.create({
            data: {
              sessionId: session.id,
              providerId: resolvedProviderId,
              amount: totalPayableAmount, // transaction represents total customer payable amount
              currency: payload.currency,
              status: 'PENDING',
              rawResponse: toJsonObject({
                type: 'merchant_payment_session_created',
                reference: session.reference,
                status: session.status
              })
            }
          });

          return session;
        });

        request.log.info(
          { ...auditContext, sessionId: created.id, reference: created.reference, providerId: resolvedProviderId },
          'Merchant payment session created'
        );

        await createAuditLog({
          actorType: 'MERCHANT',
          actorId: verified.merchant.id,
          action: 'PAYMENT_SESSION_CREATED',
          entityType: 'PaymentSession',
          entityId: created.id,
          ipAddress: request.ip,
          metadata: {
            clientId: payload.clientId,
            merchantOrderId,
            environment,
            amount: payload.amount,
            currency: payload.currency,
            providerId: provider.id
          }
        });

        return reply.status(201).send({
          data: mapSessionResponse(created)
        });
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : error instanceof z.ZodError
              ? new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', error.flatten())
              : new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Unexpected server error');

        const code = apiError.code;
        if (code === 'INVALID_SIGNATURE' || code === 'REPLAY_DETECTED' || code === 'TIMESTAMP_EXPIRED') {
          request.log.warn({ ...auditContext, code }, 'Merchant payment session signature rejected');
        } else if (code === 'KEY_REVOKED' || code === 'KEY_EXPIRED') {
          request.log.warn({ ...auditContext, code }, 'Merchant API key rejected');
        } else if (code === 'MERCHANT_INACTIVE') {
          request.log.warn({ ...auditContext, code }, 'Suspended or inactive merchant rejected');
        } else if (code === 'DOMAIN_NOT_ALLOWED') {
          request.log.warn({ ...auditContext, code }, 'Merchant domain rejected');
        } else if (code === 'UNSUPPORTED_CURRENCY') {
          request.log.warn({ ...auditContext, code }, 'Unsupported currency rejected');
        }

        throw apiError;
      }
    }
  );

  app.get(
    '/v1/session/:id',
    {
      preValidation: validateParams(sessionIdSchema),
      preHandler: [requireMerchantHmac]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof sessionIdSchema>;
      const merchantId = request.merchantAuth?.merchant.id;
      if (!merchantId) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Merchant authentication failed');
      }

      const session = await prisma.paymentSession.findFirst({
        where: { id, merchantId },
        include: { provider: true }
      });

      if (!session) {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'Payment session not found');
      }

      return {
        data: {
          session_id: session.id,
          order_id: session.orderId,
          status: session.status,
          amount: session.amount.toString(),
          currency: session.currency,
          provider: session.provider.name,
          provider_ref: session.providerReference,
          created_at: session.createdAt,
          updated_at: session.updatedAt
        }
      };
    }
  );

  app.get(
    '/admin/payment-sessions',
    { preHandler: [requireAdminAuth, requirePermission('sessions:read')] },
    async () => {
      const data = (await prisma.paymentSession.findMany({
        take: 100,
        include: {
          merchant: { select: { id: true, name: true } },
          provider: { select: { id: true, name: true, displayName: true } }
        },
        orderBy: { createdAt: 'desc' }
      })) as Array<
        PaymentSession & {
          merchant: { id: string; name: string };
          provider: { id: string; name: string; displayName: string };
        }
      >;
      return {
        data: data.map((session) => ({
          id: session.id,
          reference: session.reference,
          merchant_id: session.merchantId,
          merchant_name: session.merchant.name,
          provider_id: session.providerId,
          provider_name: session.provider.name,
          provider_display_name: session.provider.displayName,
          order_id: session.orderId,
          environment: session.environment,
          amount: session.amount.toString(),
          currency: session.currency,
          purpose: session.purpose,
          description: session.description,
          customer: session.customer,
          status: session.status,
          provider_session_id: session.providerSessionId,
          provider_reference: session.providerReference,
          expires_at: session.expiresAt,
          created_at: session.createdAt,
          updated_at: session.updatedAt
        }))
      };
    }
  );

  app.get(
    '/admin/payment-sessions/:id',
    { preHandler: [requireAdminAuth, requirePermission('sessions:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const session = (await prisma.paymentSession.findUnique({
        where: { id },
        include: {
          merchant: { select: { id: true, name: true, contactEmail: true } },
          provider: { select: { id: true, name: true, displayName: true } },
          transactions: true,
          webhookLogs: true,
          callbackLogs: true
        }
      })) as
        | (PaymentSession & {
            merchant: { id: string; name: string; contactEmail: string };
            provider: { id: string; name: string; displayName: string };
            transactions: Array<{
              id: string;
              amount: bigint;
              currency: string;
              status: string;
              providerReference: string | null;
              createdAt: Date;
            }>;
            webhookLogs: unknown[];
            callbackLogs: unknown[];
          })
        | null;
      if (!session) {
        return reply.notFound('Payment session not found');
      }
      return {
        data: {
          id: session.id,
          reference: session.reference,
          merchant_id: session.merchantId,
          merchant_name: session.merchant.name,
          merchant_contact_email: session.merchant.contactEmail,
          provider_id: session.providerId,
          provider_name: session.provider.name,
          provider_display_name: session.provider.displayName,
          order_id: session.orderId,
          environment: session.environment,
          amount: session.amount.toString(),
          currency: session.currency,
          purpose: session.purpose,
          description: session.description,
          customer: session.customer,
          status: session.status,
          provider_session_id: session.providerSessionId,
          provider_reference: session.providerReference,
          expires_at: session.expiresAt,
          created_at: session.createdAt,
          updated_at: session.updatedAt,
          transactions: session.transactions.map((transaction: (typeof session.transactions)[number]) => ({
            id: transaction.id,
            amount: transaction.amount.toString(),
            currency: transaction.currency,
            status: transaction.status,
            provider_reference: transaction.providerReference,
            created_at: transaction.createdAt
          })),
          webhook_logs: session.webhookLogs,
          callback_logs: session.callbackLogs
        }
      };
    }
  );
};
