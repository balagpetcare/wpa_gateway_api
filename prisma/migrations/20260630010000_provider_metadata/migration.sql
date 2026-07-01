-- CreateEnum
CREATE TYPE "CoverageType" AS ENUM ('LOCAL', 'REGIONAL', 'GLOBAL');

-- AlterTable: add metadata columns to payment_providers
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "adapter_type" TEXT,
  ADD COLUMN IF NOT EXISTS "coverage_type" "CoverageType" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN IF NOT EXISTS "region_code" TEXT,
  ADD COLUMN IF NOT EXISTS "logo_url" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_providers_is_active_environment_coverage_type_idx"
  ON "payment_providers"("is_active", "environment", "coverage_type");
