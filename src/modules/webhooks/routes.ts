import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { processProviderWebhook } from '../../services/provider-runtime.js';
import { ApiError } from '../../utils/errors.js';
import { validateParams } from '../../utils/validation.js';

const webhookParamsSchema = z.object({
  providerCode: z.string().min(1)
});

const epsCallbackParamsSchema = z.object({
  eventType: z.enum(['callback', 'success', 'fail', 'cancel'])
});

const bkashCallbackParamsSchema = z.object({
  eventType: z.enum(['callback'])
});

const nagadCallbackParamsSchema = z.object({
  eventType: z.enum(['callback'])
});

const sslcommerzCallbackParamsSchema = z.object({
  eventType: z.enum(['callback', 'success', 'fail', 'cancel', 'ipn'])
});

const resolveProviderByCode = async (providerCode: string) => {
  const provider = await prisma.paymentProvider.findFirst({
    where: {
      OR: [{ name: providerCode.toUpperCase() as never }, { displayName: providerCode }]
    }
  });

  if (!provider) {
    throw new ApiError(404, 'NOT_FOUND', 'Payment provider webhook endpoint not found');
  }

  return provider;
};

const buildRedirectUrl = (session: { returnUrl: string; reference: string }, resultStatus?: string) => {
  const target = new URL(session.returnUrl);
  target.searchParams.set('reference', session.reference);
  if (resultStatus) {
    target.searchParams.set('provider_status', resultStatus.toLowerCase());
  }
  return target.toString();
};

const ensureSupportedEpsCallbackContentType = (request: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}) => {
  if (request.method !== 'POST') {
    return;
  }

  const contentTypeHeader = request.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.split(';')[0]?.trim().toLowerCase() : '';
  if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
    return;
  }

  throw new ApiError(415, 'VALIDATION_ERROR', 'EPS callback content type is not supported');
};

const ensureSupportedBkashCallbackContentType = (request: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}) => {
  if (request.method !== 'POST') {
    return;
  }

  const contentTypeHeader = request.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.split(';')[0]?.trim().toLowerCase() : '';
  if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
    return;
  }

  throw new ApiError(415, 'VALIDATION_ERROR', 'BKASH callback content type is not supported');
};

const ensureSupportedNagadCallbackContentType = (request: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}) => {
  if (request.method !== 'POST') {
    return;
  }

  const contentTypeHeader = request.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.split(';')[0]?.trim().toLowerCase() : '';
  if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
    return;
  }

  throw new ApiError(415, 'VALIDATION_ERROR', 'NAGAD callback content type is not supported');
};

const ensureSupportedSSLCommerzCallbackContentType = (request: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}) => {
  if (request.method !== 'POST') {
    return;
  }

  const contentTypeHeader = request.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.split(';')[0]?.trim().toLowerCase() : '';
  if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
    return;
  }

  throw new ApiError(415, 'VALIDATION_ERROR', 'SSLCOMMERZ callback content type is not supported');
};

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/v1/webhooks/:providerCode',
    {
      config: {
        rateLimit: {
          // Providers retry on failure so we allow a higher ceiling, but still
          // cap to prevent a compromised provider from flooding the queue.
          max: 200,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.ip
        }
      },
      preValidation: validateParams(webhookParamsSchema)
    },
    async (request, reply) => {
      const { providerCode } = request.params as z.infer<typeof webhookParamsSchema>;
      const provider = await resolveProviderByCode(providerCode);

      const rawBody =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});

      const result = await processProviderWebhook({
        providerId: provider.id,
        headers: request.headers,
        rawBody,
        requestIp: request.ip
      });

      return reply.status(200).send({
        received: true,
        duplicate: result.duplicate
      });
    }
  );

  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/providers/eps/:eventType',
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.ip
      }
    },
    preValidation: validateParams(epsCallbackParamsSchema),
    handler: async (request, reply) => {
      ensureSupportedEpsCallbackContentType(request);

      const provider = await resolveProviderByCode('EPS');
      const { eventType } = request.params as z.infer<typeof epsCallbackParamsSchema>;
      const payload =
        request.method === 'GET'
          ? (request.query as Record<string, unknown>)
          : ((request.body as Record<string, unknown> | undefined) ?? {});
      const rawBody = JSON.stringify(payload);

      const result = await processProviderWebhook({
        providerId: provider.id,
        headers: {
          ...request.headers,
          'x-provider-callback-type': eventType
        },
        rawBody,
        requestIp: request.ip
      });

      const session =
        result.sessionId
          ? await prisma.paymentSession.findUnique({
              where: { id: result.sessionId },
              select: { id: true, reference: true, returnUrl: true, status: true }
            })
          : null;

      if (request.method === 'GET' && session && result.verified) {
        return reply.redirect(buildRedirectUrl(session, session.status));
      }

      return reply.status(result.verified ? 200 : result.matched === false ? 404 : 400).send({
        received: true,
        verified: result.verified ?? false,
        duplicate: result.duplicate ?? false,
        status: session?.status ?? null,
        reference: session?.reference ?? null
      });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/providers/bkash/:eventType',
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.ip
      }
    },
    preValidation: validateParams(bkashCallbackParamsSchema),
    handler: async (request, reply) => {
      ensureSupportedBkashCallbackContentType(request);

      const provider = await resolveProviderByCode('BKASH');
      const payload =
        request.method === 'GET'
          ? (request.query as Record<string, unknown>)
          : ((request.body as Record<string, unknown> | undefined) ?? {});
      const rawBody = JSON.stringify(payload);

      const result = await processProviderWebhook({
        providerId: provider.id,
        headers: request.headers,
        rawBody,
        requestIp: request.ip
      });

      const session =
        result.sessionId
          ? await prisma.paymentSession.findUnique({
              where: { id: result.sessionId },
              select: { id: true, reference: true, returnUrl: true, status: true }
            })
          : null;

      if (request.method === 'GET' && session && result.verified) {
        return reply.redirect(buildRedirectUrl(session, session.status));
      }

      return reply.status(result.verified ? 200 : result.matched === false ? 404 : 400).send({
        received: true,
        verified: result.verified ?? false,
        duplicate: result.duplicate ?? false,
        status: session?.status ?? null,
        reference: session?.reference ?? null
      });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/providers/nagad/:eventType',
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.ip
      }
    },
    preValidation: validateParams(nagadCallbackParamsSchema),
    handler: async (request, reply) => {
      ensureSupportedNagadCallbackContentType(request);

      const provider = await resolveProviderByCode('NAGAD');
      const payload =
        request.method === 'GET'
          ? (request.query as Record<string, unknown>)
          : ((request.body as Record<string, unknown> | undefined) ?? {});
      const rawBody = JSON.stringify(payload);

      const result = await processProviderWebhook({
        providerId: provider.id,
        headers: request.headers,
        rawBody,
        requestIp: request.ip
      });

      const session =
        result.sessionId
          ? await prisma.paymentSession.findUnique({
              where: { id: result.sessionId },
              select: { id: true, reference: true, returnUrl: true, status: true }
            })
          : null;

      if (request.method === 'GET' && session && result.verified) {
        return reply.redirect(buildRedirectUrl(session, session.status));
      }

      return reply.status(result.verified ? 200 : result.matched === false ? 404 : 400).send({
        received: true,
        verified: result.verified ?? false,
        duplicate: result.duplicate ?? false,
        status: session?.status ?? null,
        reference: session?.reference ?? null
      });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/providers/sslcommerz/:eventType',
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.ip
      }
    },
    preValidation: validateParams(sslcommerzCallbackParamsSchema),
    handler: async (request, reply) => {
      ensureSupportedSSLCommerzCallbackContentType(request);

      const provider = await resolveProviderByCode('SSLCOMMERZ');
      const { eventType } = request.params as z.infer<typeof sslcommerzCallbackParamsSchema>;
      const payload =
        request.method === 'GET'
          ? (request.query as Record<string, unknown>)
          : ((request.body as Record<string, unknown> | undefined) ?? {});
      const rawBody = JSON.stringify(payload);

      const result = await processProviderWebhook({
        providerId: provider.id,
        headers: {
          ...request.headers,
          'x-provider-callback-type': eventType
        },
        rawBody,
        requestIp: request.ip
      });

      const session =
        result.sessionId
          ? await prisma.paymentSession.findUnique({
              where: { id: result.sessionId },
              select: { id: true, reference: true, returnUrl: true, status: true }
            })
          : null;

      if (request.method === 'GET' && session && result.verified) {
        return reply.redirect(buildRedirectUrl(session, session.status));
      }

      return reply.status(result.verified ? 200 : result.matched === false ? 404 : 400).send({
        received: true,
        verified: result.verified ?? false,
        duplicate: result.duplicate ?? false,
        status: session?.status ?? null,
        reference: session?.reference ?? null
      });
    }
  });
};
