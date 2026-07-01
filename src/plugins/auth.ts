import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env.js';

export const authPlugin = fp(async (app) => {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required but not set');
  }

  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN
    }
  });
});
