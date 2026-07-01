import type { FastifyRequest } from 'fastify';
import { env, trustProxy } from '../config/env.js';

const trimSlashes = (value: string) => value.replace(/\/+$/, '');

const readForwardedHost = (request: FastifyRequest) => {
  const header = request.headers['x-forwarded-host'];
  if (!trustProxy || typeof header !== 'string' || header.trim().length === 0) {
    return null;
  }

  return header.split(',')[0]?.trim() ?? null;
};

const readForwardedProto = (request: FastifyRequest) => {
  const header = request.headers['x-forwarded-proto'];
  if (!trustProxy || typeof header !== 'string' || header.trim().length === 0) {
    return null;
  }

  return header.split(',')[0]?.trim() ?? null;
};

export const resolveGatewayBaseUrl = (request: FastifyRequest) => {
  if (env.PUBLIC_GATEWAY_URL) {
    return trimSlashes(env.PUBLIC_GATEWAY_URL);
  }

  const protocol = readForwardedProto(request) ?? request.protocol ?? 'http';
  const host = readForwardedHost(request) ?? request.headers.host ?? '127.0.0.1:4000';
  return `${protocol}://${host}`;
};

export const buildGatewayUrl = (request: FastifyRequest, path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveGatewayBaseUrl(request)}${normalizedPath}`;
};
