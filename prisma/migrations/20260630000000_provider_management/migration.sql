-- AlterEnum: Add new ProviderName values
ALTER TYPE "ProviderName" ADD VALUE IF NOT EXISTS 'BKASH';
ALTER TYPE "ProviderName" ADD VALUE IF NOT EXISTS 'NAGAD';
ALTER TYPE "ProviderName" ADD VALUE IF NOT EXISTS 'SSLCOMMERZ';
ALTER TYPE "ProviderName" ADD VALUE IF NOT EXISTS 'CASHFREE';
ALTER TYPE "ProviderName" ADD VALUE IF NOT EXISTS 'PAYPAL';
ALTER TYPE "ProviderName" ADD VALUE IF NOT EXISTS 'AUTHORIZE_NET';

-- AlterTable: Add environment and isDevelopmentOnly columns
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
  ADD COLUMN IF NOT EXISTS "is_development_only" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex: Remove old unique constraint on name alone
DROP INDEX IF EXISTS "payment_providers_name_key";

-- CreateIndex: Add compound unique constraint (name, environment)
CREATE UNIQUE INDEX IF NOT EXISTS "payment_providers_name_environment_key"
  ON "payment_providers"("name", "environment");
