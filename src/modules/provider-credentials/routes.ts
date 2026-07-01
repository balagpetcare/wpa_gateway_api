import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { requireAdminAuth } from '../../middleware/admin-auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { encryptValue } from '../../utils/encrypt.js';
import { ApiError } from '../../utils/errors.js';
import { validateBody, validateParams } from '../../utils/validation.js';
import { runCredentialProfileTest } from '../../services/provider-credential-test.js';

const providerIdSchema = z.object({
  providerId: z.string().min(1),
  credId: z.string().min(1).optional()
});

const providerCredentialIdSchema = z.object({
  providerId: z.string().min(1),
  credId: z.string().min(1)
});

const profileIdSchema = z.object({
  providerId: z.string().min(1),
  credId: z.string().min(1)
});

const updateProfileSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION']).optional(),
  supportedPurposes: z.array(
    z.enum(['DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'SETTLEMENT', 'GENERAL_SALE', 'ALL_PURPOSES'])
  ).min(1).optional(),
  countryCodes: z.array(z.string().min(2).max(3)).optional(),
  currencyCodes: z.array(z.string().length(3)).optional(),
  priority: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
  secrets: z.record(z.string(), z.string()).optional()
}).refine((data) => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update.'
});

const createCredentialSchema = z.object({
  merchant_id: z.string().min(1).nullable().default(null),
  key_label: z.string().min(1).max(100),
  value: z.string().min(1)
});

const profileTestParamsSchema = z.object({
  profileId: z.string().min(1)
});

const profileTestBodySchema = z.object({
  environment: z.enum(['SANDBOX', 'PRODUCTION']),
  mode: z.enum(['DRY_RUN', 'LIVE']),
  testAmount: z.string().min(1).default('10.00'),
  currency: z.string().length(3).default('BDT')
});

const createProfileSchema = z.object({
  label: z.string().min(1),
  environment: z.enum(['SANDBOX', 'PRODUCTION']),
  scope: z.enum(['PLATFORM', 'MERCHANT']),
  merchantId: z.string().nullable().optional(),
  supportedPurposes: z.array(z.enum(['DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'SETTLEMENT', 'GENERAL_SALE', 'ALL_PURPOSES'])),
  countryCodes: z.array(z.string()),
  currencyCodes: z.array(z.string()),
  priority: z.number().default(100),
  isActive: z.boolean().default(true),
  secrets: z.record(z.string(), z.string())
});

export const providerCredentialRoutes: FastifyPluginAsync = async (app) => {
  // Existing POST route for legacy credentials
  app.post(
    '/admin/providers/:providerId/credentials',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(providerIdSchema), validateBody(createCredentialSchema)]
    },
    async (request, reply) => {
      const { providerId } = request.params as z.infer<typeof providerIdSchema>;
      const payload = request.body as z.infer<typeof createCredentialSchema>;
      const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
      const encrypted = encryptValue(payload.value, encryptionKey);

      const credential = await prisma.providerCredential.create({
        data: {
          providerId,
          merchantId: payload.merchant_id,
          scope: payload.merchant_id ? 'MERCHANT' : 'PLATFORM',
          keyLabel: payload.key_label,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext,
          createdById: request.adminUser?.id ?? null
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'PROVIDER_CREDENTIAL_CREATED',
          entityType: 'ProviderCredential',
          entityId: credential.id,
          ipAddress: request.ip,
          metadata: {
            providerId,
            merchantId: payload.merchant_id,
            keyLabel: payload.key_label
          }
        }
      });

      return reply.status(201).send({
        data: {
          id: credential.id,
          key_label: credential.keyLabel,
          merchant_id: credential.merchantId,
          created_at: credential.createdAt
        }
      });
    }
  );

  // POST route for Credential Profiles
  app.post(
    '/admin/providers/:providerId/credential-profiles',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(providerIdSchema), validateBody(createProfileSchema)]
    },
    async (request, reply) => {
      const { providerId } = request.params as z.infer<typeof providerIdSchema>;
      const payload = request.body as z.infer<typeof createProfileSchema>;

      // Mask/Encrypt secrets logic (simplifying here by storing the keys securely or storing encrypted values in json)
      // For grouped secrets: let's encrypt the whole JSON or encrypt each field. Let's encrypt the entire JSON structure or simple JSON representation.
      // Since it's saved as "encryptedSecrets JSON field", we can encrypt it using encryptValue or similar, or just save it.
      // Let's encrypt each key in payload.secrets or encrypt the whole JSON to string, then save.
      // Wait, let's keep it simple: we can JSON.stringify the secrets, encrypt it, and store. But the model says "encryptedSecrets Json field".
      // To satisfy "encryptedSecrets Json field" type: we can store it as `{ encryptedData: ciphertext, iv, authTag }`.
      const secretsStr = JSON.stringify(payload.secrets);
      const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
      const encrypted = encryptValue(secretsStr, encryptionKey);
      const encryptedSecretsJson = {
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        ciphertext: encrypted.ciphertext
      };

      const profile = await prisma.credentialProfile.create({
        data: {
          providerId,
          merchantId: payload.scope === 'MERCHANT' ? payload.merchantId : null,
          scope: payload.scope,
          environment: payload.environment,
          label: payload.label,
          supportedPurposes: payload.supportedPurposes as any,
          countryCodes: payload.countryCodes,
          currencyCodes: payload.currencyCodes,
          priority: payload.priority,
          isActive: payload.isActive,
          encryptedSecrets: encryptedSecretsJson,
          createdById: request.adminUser?.id ?? null
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'CREDENTIAL_PROFILE_CREATED',
          entityType: 'CredentialProfile',
          entityId: profile.id,
          ipAddress: request.ip,
          metadata: {
            providerId,
            label: payload.label
          }
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { encryptedSecrets: _secrets, ...safeProfile } = profile;
      return reply.status(201).send({
        data: safeProfile
      });
    }
  );

  // Existing GET route: updated to fetch both legacy credentials and credential profiles
  app.get(
    '/admin/providers/:providerId/credentials',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:read')],
      preValidation: validateParams(providerIdSchema)
    },
    async (request) => {
      const { providerId } = request.params as z.infer<typeof providerIdSchema>;

      // Load legacy credentials
      const legacyData = await prisma.providerCredential.findMany({
        where: { providerId, isActive: true },
        select: { id: true, keyLabel: true, merchantId: true, scope: true, createdAt: true }
      });

      // Load credential profiles
      const profilesData = await prisma.credentialProfile.findMany({
        where: { providerId, isActive: true },
        select: {
          id: true,
          label: true,
          merchantId: true,
          scope: true,
          environment: true,
          supportedPurposes: true,
          countryCodes: true,
          currencyCodes: true,
          priority: true,
          isActive: true,
          createdAt: true,
          lastTestStatus: true,
          lastTestedAt: true,
          lastTestEnvironment: true,
          lastTestMessage: true
        }
      });

      // Return both mapped to the front-end format or combined list
      const legacyMapped = legacyData.map((row) => ({
        id: row.id,
        key_label: row.keyLabel,
        merchant_id: row.merchantId,
        scope: row.scope,
        created_at: row.createdAt,
        isProfile: false
      }));

      const profilesMapped = profilesData.map((row) => ({
        id: row.id,
        key_label: row.label, // mapped to name/label
        merchant_id: row.merchantId,
        scope: row.scope,
        created_at: row.createdAt,
        isProfile: true,
        environment: row.environment,
        supportedPurposes: row.supportedPurposes,
        countryCodes: row.countryCodes,
        currencyCodes: row.currencyCodes,
        priority: row.priority,
        isActive: row.isActive,
        lastTestStatus: row.lastTestStatus ?? 'NOT_TESTED',
        lastTestedAt: row.lastTestedAt,
        lastTestEnvironment: row.lastTestEnvironment,
        lastTestMessage: row.lastTestMessage
      }));

      return {
        data: [...legacyMapped, ...profilesMapped]
      };
    }
  );

  // PATCH route: update a CredentialProfile (not applicable to legacy ProviderCredential rows)
  app.patch(
    '/admin/providers/:providerId/credentials/:credId',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(profileIdSchema), validateBody(updateProfileSchema)]
    },
    async (request, reply) => {
      const { providerId, credId } = request.params as z.infer<typeof profileIdSchema>;
      const payload = request.body as z.infer<typeof updateProfileSchema>;

      const profile = await prisma.credentialProfile.findUnique({
        where: { id: credId },
        select: { id: true, providerId: true, label: true }
      });

      if (!profile) {
        throw new ApiError(404, 'NOT_FOUND', 'Credential profile not found. Legacy credentials cannot be updated via this endpoint.');
      }

      if (profile.providerId !== providerId) {
        throw new ApiError(404, 'NOT_FOUND', 'Credential profile does not belong to the specified provider.');
      }

      // Build update data — only include fields that were explicitly sent
      const updateData: Record<string, unknown> = {};
      if (payload.label !== undefined) updateData.label = payload.label;
      if (payload.environment !== undefined) updateData.environment = payload.environment;
      if (payload.supportedPurposes !== undefined) updateData.supportedPurposes = payload.supportedPurposes;
      if (payload.countryCodes !== undefined) updateData.countryCodes = payload.countryCodes.map((c) => c.toUpperCase());
      if (payload.currencyCodes !== undefined) updateData.currencyCodes = payload.currencyCodes.map((c) => c.toUpperCase());
      if (payload.priority !== undefined) updateData.priority = payload.priority;
      if (payload.isActive !== undefined) updateData.isActive = payload.isActive;

      // Re-encrypt secrets only when explicitly provided — never touches stored secrets otherwise
      if (payload.secrets !== undefined) {
        const secretsStr = JSON.stringify(payload.secrets);
        const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
        const encrypted = encryptValue(secretsStr, encryptionKey);
        updateData.encryptedSecrets = {
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          ciphertext: encrypted.ciphertext
        };
      }

      const updated = await prisma.credentialProfile.update({
        where: { id: credId },
        data: updateData,
        select: {
          id: true,
          providerId: true,
          merchantId: true,
          scope: true,
          environment: true,
          label: true,
          supportedPurposes: true,
          countryCodes: true,
          currencyCodes: true,
          priority: true,
          isActive: true,
          createdAt: true,
          updatedAt: true
          // encryptedSecrets intentionally excluded
        }
      });

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'CREDENTIAL_PROFILE_UPDATED',
          entityType: 'CredentialProfile',
          entityId: credId,
          ipAddress: request.ip,
          metadata: {
            providerId,
            updatedFields: Object.keys(updateData).filter((k) => k !== 'encryptedSecrets'),
            secretsUpdated: payload.secrets !== undefined
          }
        }
      });

      return reply.status(200).send({
        data: updated
      });
    }
  );

  // DELETE route supporting both legacy credentials and credential profiles
  app.delete(
    '/admin/providers/:providerId/credentials/:credId',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: validateParams(providerCredentialIdSchema)
    },
    async (request, reply) => {
      const { providerId, credId } = request.params as z.infer<typeof providerCredentialIdSchema>;

      // Check if it's a profile or a legacy row
      const profile = await prisma.credentialProfile.findUnique({
        where: { id: credId }
      });

      if (profile) {
        await prisma.credentialProfile.update({
          where: { id: credId },
          data: { isActive: false }
        });
      } else {
        await prisma.providerCredential.update({
          where: { id: credId },
          data: { isActive: false }
        });
      }

      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: request.adminUser?.id ?? null,
          action: 'PROVIDER_CREDENTIAL_DISABLED',
          entityType: profile ? 'CredentialProfile' : 'ProviderCredential',
          entityId: credId,
          ipAddress: request.ip,
          metadata: { providerId }
        }
      });

      return reply.status(200).send({
        data: {
          id: credId,
          disabled: true
        }
      });
    }
  );

  // Run a credential profile verification test (DRY_RUN or LIVE) and persist the result
  app.post(
    '/admin/provider-credentials/:profileId/test',
    {
      preHandler: [requireAdminAuth, requirePermission('providers:write')],
      preValidation: [validateParams(profileTestParamsSchema), validateBody(profileTestBodySchema)]
    },
    async (request, reply) => {
      const { profileId } = request.params as z.infer<typeof profileTestParamsSchema>;
      const payload = request.body as z.infer<typeof profileTestBodySchema>;

      const result = await runCredentialProfileTest({
        profileId,
        environment: payload.environment,
        mode: payload.mode,
        testAmount: payload.testAmount,
        currency: payload.currency.toUpperCase(),
        adminUserId: request.adminUser?.id ?? null,
        ipAddress: request.ip
      });

      return reply.status(200).send({
        data: result
      });
    }
  );
};
