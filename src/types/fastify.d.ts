import type { AdminRole, Merchant, MerchantApiKey } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: {
      id: string;
      email: string;
      role: AdminRole;
    };
    merchantAuth?: {
      merchant: Pick<Merchant, 'id' | 'name' | 'status' | 'callbackUrl'>;
      apiKey: Pick<MerchantApiKey, 'id' | 'label' | 'clientId' | 'environment'>;
      secret: string;
    };
    requestId: string;
  }
}
