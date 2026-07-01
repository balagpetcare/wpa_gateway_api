import type { FastifyRequest } from 'fastify';
import type { ZodSchema } from 'zod';
import { ZodError } from 'zod';
import { ApiError } from './errors.js';

const parseOrThrow = <T>(schema: ZodSchema<T>, input: unknown): T => {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', error.flatten());
    }

    throw error;
  }
};

export const validateBody =
  <T>(schema: ZodSchema<T>) =>
  async (request: FastifyRequest) => {
    request.body = parseOrThrow(schema, request.body);
  };

export const validateParams =
  <T>(schema: ZodSchema<T>) =>
  async (request: FastifyRequest) => {
    request.params = parseOrThrow(schema, request.params);
  };

export const validateQuery =
  <T>(schema: ZodSchema<T>) =>
  async (request: FastifyRequest) => {
    request.query = parseOrThrow(schema, request.query);
  };
