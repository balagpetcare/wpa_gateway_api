-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('DONATION', 'MEMBERSHIP', 'CAMPAIGN', 'MARKETPLACE', 'SUBSCRIPTION', 'SETTLEMENT', 'GENERAL_SALE', 'ALL_PURPOSES');

-- CreateEnum
CREATE TYPE "FeeBearer" AS ENUM ('CUSTOMER', 'MERCHANT', 'PLATFORM', 'SHARED');

-- AlterTable: add providerCode to payment_providers
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "provider_code" TEXT;

-- CreateIndex (unique providerCode + environment, partial to allow NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS "payment_providers_provider_code_environment_key"
  ON "payment_providers" ("provider_code", "environment");

-- CreateTable: settlement_profiles
CREATE TABLE IF NOT EXISTS "settlement_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope_type" "CredentialScope" NOT NULL DEFAULT 'PLATFORM',
    "scope_id" TEXT,
    "country_code" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "purpose" "PaymentPurpose",
    "payout_schedule" TEXT,
    "metadata" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "settlement_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: credential_profiles
CREATE TABLE IF NOT EXISTS "credential_profiles" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "scope" "CredentialScope" NOT NULL DEFAULT 'PLATFORM',
    "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "label" TEXT NOT NULL,
    "supported_purposes" "PaymentPurpose"[],
    "country_codes" TEXT[],
    "currency_codes" TEXT[],
    "settlement_profile_id" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "encrypted_secrets" JSONB NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "credential_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: gateway_routing_rules
CREATE TABLE IF NOT EXISTS "gateway_routing_rules" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "credential_profile_id" TEXT,
    "country_code" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "scope_type" "CredentialScope" NOT NULL DEFAULT 'PLATFORM',
    "scope_id" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "show_at_checkout" BOOLEAN NOT NULL DEFAULT true,
    "fallback_allowed" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gateway_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: gateway_fee_rules
CREATE TABLE IF NOT EXISTS "gateway_fee_rules" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "credential_profile_id" TEXT,
    "country_code" TEXT,
    "currency_code" TEXT,
    "purpose" "PaymentPurpose" NOT NULL,
    "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "percentage_fee" DECIMAL(5,2) NOT NULL,
    "fixed_fee" DECIMAL(20,8) NOT NULL,
    "min_fee" DECIMAL(20,8),
    "max_fee" DECIMAL(20,8),
    "fee_bearer" "FeeBearer" NOT NULL DEFAULT 'MERCHANT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gateway_fee_rules_pkey" PRIMARY KEY ("id")
);

-- AlterTable: add new columns to payment_sessions
ALTER TABLE "payment_sessions"
  ADD COLUMN IF NOT EXISTS "credential_profile_id"  TEXT,
  ADD COLUMN IF NOT EXISTS "routing_fallback_level"  TEXT,
  ADD COLUMN IF NOT EXISTS "settlement_profile_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "gateway_fee"             BIGINT,
  ADD COLUMN IF NOT EXISTS "platform_fee"            BIGINT,
  ADD COLUMN IF NOT EXISTS "total_payable_amount"    BIGINT,
  ADD COLUMN IF NOT EXISTS "fee_bearer"              "FeeBearer",
  ADD COLUMN IF NOT EXISTS "net_settlement_amount"   BIGINT;

-- CreateIndex for credential_profiles
CREATE UNIQUE INDEX IF NOT EXISTS "credential_profiles_provider_id_environment_scope_merchant_id_label_key"
  ON "credential_profiles" ("provider_id", "environment", "scope", "merchant_id", "label");
CREATE INDEX IF NOT EXISTS "credential_profiles_provider_id_environment_is_active_idx"
  ON "credential_profiles" ("provider_id", "environment", "is_active");

-- CreateIndex for gateway_routing_rules
CREATE UNIQUE INDEX IF NOT EXISTS "gateway_routing_rules_country_code_currency_code_purpose_provid_key"
  ON "gateway_routing_rules" ("country_code", "currency_code", "purpose", "provider_id", "environment", "scope_type", "scope_id");
CREATE INDEX IF NOT EXISTS "gateway_routing_rules_provider_id_environment_is_active_idx"
  ON "gateway_routing_rules" ("provider_id", "environment", "is_active");

-- AddForeignKey: credential_profiles -> payment_providers
ALTER TABLE "credential_profiles"
  ADD CONSTRAINT "credential_profiles_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: credential_profiles -> merchants
ALTER TABLE "credential_profiles"
  ADD CONSTRAINT "credential_profiles_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: credential_profiles -> settlement_profiles
ALTER TABLE "credential_profiles"
  ADD CONSTRAINT "credential_profiles_settlement_profile_id_fkey"
  FOREIGN KEY ("settlement_profile_id") REFERENCES "settlement_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: credential_profiles -> admin_users
ALTER TABLE "credential_profiles"
  ADD CONSTRAINT "credential_profiles_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: gateway_routing_rules -> payment_providers
ALTER TABLE "gateway_routing_rules"
  ADD CONSTRAINT "gateway_routing_rules_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: gateway_routing_rules -> credential_profiles
ALTER TABLE "gateway_routing_rules"
  ADD CONSTRAINT "gateway_routing_rules_credential_profile_id_fkey"
  FOREIGN KEY ("credential_profile_id") REFERENCES "credential_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: gateway_fee_rules -> payment_providers
ALTER TABLE "gateway_fee_rules"
  ADD CONSTRAINT "gateway_fee_rules_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: gateway_fee_rules -> credential_profiles
ALTER TABLE "gateway_fee_rules"
  ADD CONSTRAINT "gateway_fee_rules_credential_profile_id_fkey"
  FOREIGN KEY ("credential_profile_id") REFERENCES "credential_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: payment_sessions -> credential_profiles
ALTER TABLE "payment_sessions"
  ADD CONSTRAINT "payment_sessions_credential_profile_id_fkey"
  FOREIGN KEY ("credential_profile_id") REFERENCES "credential_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: payment_sessions -> settlement_profiles
ALTER TABLE "payment_sessions"
  ADD CONSTRAINT "payment_sessions_settlement_profile_id_fkey"
  FOREIGN KEY ("settlement_profile_id") REFERENCES "settlement_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
