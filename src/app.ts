import crypto from 'node:crypto';
import { parse as parseQueryString } from 'node:querystring';
import fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { env, hasRequiredSecrets, trustProxy } from './config/env.js';
import { authPlugin } from './plugins/auth.js';
import { registerModules } from './modules/index.js';
import { adminAuditHook } from './middleware/admin-audit.js';
import { ApiError, sendError } from './utils/errors.js';

// Parsed once at startup; never re-read from env at request time.
const adminOrigins = new Set(
  env.ADMIN_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
);

export const buildApp = () => {
  const redactPaths = [
    'req.headers.authorization',
    'req.headers.x-hash',
    'req.headers.x-signature',
    'req.headers.x-api-key',
    'req.headers.x-gateway-signature',
    'req.body.value',
    'req.body.password',
    'req.body.privateKey',
    'req.body.private_key',
    'req.body.publicKey',
    'req.body.public_key',
    'req.body.storePassword',
    'req.body.store_passwd',
    'req.body.hashKey',
    'req.body.hash_key',
    'req.body.secret',
    'req.body.apiKey',
    'req.body.api_key',
    'response.body.api_key',
    'response.body.hmac_secret',
    'response.body.credentials.client_secret',
    'response.body.access_token',
    'response.body.refresh_token'
  ];

  const logger =
    env.NODE_ENV === 'development'
      ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' }, redact: { paths: redactPaths, remove: true } }
      : { level: env.LOG_LEVEL, redact: { paths: redactPaths, remove: true } };

  const app = fastify({
    logger,
    genReqId: () => `req_${crypto.randomUUID()}`,
    trustProxy
  });

  // ── Plugins ──────────────────────────────────────────────────────────────

  app.register(sensible);

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parseQueryString(typeof body === 'string' ? body : body.toString('utf8')));
      } catch (error) {
        done(error as Error);
      }
    }
  );

  // CORS:
  //   • /admin/* → only the configured ADMIN_ORIGINS
  //   • /api/v1/webhooks/* → no CORS (server-to-server only; Origin header present = block)
  //   • /api/v1/* and /v1/* → permissive; real security is HMAC + domain allowlist
  app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header → server-to-server; allow unconditionally
      if (!origin) {
        cb(null, true);
        return;
      }

      // Admin panel origins must match exactly
      if (adminOrigins.has(origin)) {
        cb(null, true);
        return;
      }

      // Merchant-facing public API: CORS is intentionally open here because the
      // security controls are HMAC signature + domain allowlist, not same-origin.
      // Browsers that do send an Origin will get it reflected back.
      cb(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Merchant-ID',
      'X-Timestamp',
      'X-Signature',
      'X-Api-Key',
      'X-Request-ID'
    ],
    exposedHeaders: ['X-Request-ID']
  });

  // Rate limiter — global=false means no default; limits are set per-route.
  app.register(rateLimit, { global: false });

  app.register(authPlugin);

  // ── Global hooks ─────────────────────────────────────────────────────────

  // Reflect the generated request ID so clients can correlate logs.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Request-ID', _request.id);
  });

  // Automatic audit trail for all mutating admin API calls.
  app.addHook('onResponse', adminAuditHook);

  // ── Health ────────────────────────────────────────────────────────────────

  app.get(
    '/health',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute'
        }
      }
    },
    async () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
      secrets_configured: hasRequiredSecrets
    })
  );

  // ── Error handler ─────────────────────────────────────────────────────────

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return sendError(reply, request, error);
    }

    if (error instanceof ZodError) {
      // Flatten field errors but never include raw internal Zod state.
      const flattened = error.flatten();
      return sendError(
        reply,
        request,
        new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', {
          fieldErrors: flattened.fieldErrors,
          formErrors: flattened.formErrors
        })
      );
    }

    // Rate-limit errors from @fastify/rate-limit arrive here as 429 HTTP errors.
    const maybeHttp = error as Record<string, unknown>;
    if (typeof maybeHttp === 'object' && maybeHttp !== null && maybeHttp['statusCode'] === 429) {
      return sendError(reply, request, new ApiError(429, 'FORBIDDEN', 'Too many requests, please try again later'));
    }

    if (
      typeof maybeHttp === 'object' &&
      maybeHttp !== null &&
      typeof maybeHttp['statusCode'] === 'number' &&
      typeof maybeHttp['message'] === 'string'
    ) {
      return sendError(
        reply,
        request,
        new ApiError(maybeHttp['statusCode'] as number, 'VALIDATION_ERROR', maybeHttp['message'] as string)
      );
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return sendError(reply, request, new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Unexpected server error'));
  });

  // ── Modules ───────────────────────────────────────────────────────────────

  app.register(async (instance) => {
    await registerModules(instance);
  });

  return app;
};
