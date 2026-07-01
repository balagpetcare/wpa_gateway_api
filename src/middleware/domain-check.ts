import type { FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/errors.js';

const domainCache = new Map<string, { domains: string[]; expiresAt: number }>();

const getHostname = (value: string) => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
};

export const enforceMerchantDomain = async (request: FastifyRequest) => {
  const merchantId = request.merchantAuth?.merchant.id;
  if (!merchantId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Merchant authentication required before domain validation');
  }
  if (!request.merchantAuth) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Merchant authentication required before domain validation');
  }

  const origin = request.headers.origin;
  const referer = request.headers.referer;
  const source = typeof origin === 'string' ? origin : typeof referer === 'string' ? referer : undefined;

  if (!source) {
    return;
  }

  const hostname = getHostname(source);
  const environment = request.merchantAuth.apiKey.environment;
  const cacheKey = `${merchantId}:${environment}`;
  const cached = domainCache.get(cacheKey);
  const now = Date.now();

  if (!cached || cached.expiresAt < now) {
    const rows = await prisma.merchantDomain.findMany({
      where: {
        merchantId,
        environment,
        status: 'ACTIVE'
      },
      select: { normalizedOrigin: true }
    });

    domainCache.set(cacheKey, {
      domains: rows.map((row: { normalizedOrigin: string }) => row.normalizedOrigin.toLowerCase()),
      expiresAt: now + 60_000
    });
  }

  const domains = domainCache.get(cacheKey)?.domains ?? [];
  if (!domains.includes(hostname)) {
    throw new ApiError(403, 'DOMAIN_NOT_ALLOWED', 'Origin is not in merchant allowlist');
  }
};
