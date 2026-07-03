import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/wpa_gateway'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PUBLIC_GATEWAY_URL: z.string().url().optional(),
  TRUST_PROXY: z.union([z.literal('true'), z.literal('false')]).default('false'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1, 'CREDENTIAL_ENCRYPTION_KEY must not be empty'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET must not be empty'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET must not be empty'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  HMAC_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  // Comma-separated list of origins allowed to reach /admin/* endpoints
  ADMIN_ORIGINS: z.string().default('http://localhost:3000'),
  PUBLIC_SITE_URL: z.string().url().optional(),
  // How long to keep used HMAC signatures in the replay-protection store (seconds)
  NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  ALLOW_MOCK_PROVIDERS: z.union([z.literal('true'), z.literal('false')]).default('false'),
  ALLOW_INCOMPLETE_PROVIDERS: z.union([z.literal('true'), z.literal('false')]).default('false'),
  REQUIRE_PROVIDER_VERIFICATION_FOR_CHECKOUT: z.union([z.literal('true'), z.literal('false')]).default('false'),
  BACKGROUND_JOBS_ENABLED: z.union([z.literal('true'), z.literal('false')]).default('false'),
  JOB_SESSION_EXPIRY_ENABLED: z.union([z.literal('true'), z.literal('false')]).default('true'),
  JOB_SESSION_EXPIRY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  JOB_CALLBACK_RETRY_ENABLED: z.union([z.literal('true'), z.literal('false')]).default('true'),
  JOB_CALLBACK_RETRY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  JOB_CALLBACK_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  JOB_PAYOUT_STALE_REVIEW_ENABLED: z.union([z.literal('true'), z.literal('false')]).default('true'),
  JOB_PAYOUT_STALE_REVIEW_INTERVAL_SECONDS: z.coerce.number().int().positive().default(900),
  JOB_PAYOUT_STALE_HOURS: z.coerce.number().int().positive().default(24),
  CENTRAL_AUTH_BASE_URL: z.string().url().optional(),
  CENTRAL_COMMUNICATION_API_URL: z.string().url().optional(),
  CENTRAL_CLIENT_ID: z.string().min(1).optional(),
  CENTRAL_SERVICE_API_KEY: z.string().min(1).optional()
});

export const env = envSchema.parse(process.env);

export const trustProxy = env.TRUST_PROXY === 'true';

// All three secrets are now enforced non-empty by the schema above.
// This export is kept for backward compatibility but is always true at runtime.
export const hasRequiredSecrets = true;
