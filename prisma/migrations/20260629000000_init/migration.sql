-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MerchantEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "MerchantApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "MerchantDomainStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ProviderName" AS ENUM ('RAZORPAY', 'PAYU', 'CCAVENUE', 'STRIPE');

-- CreateEnum
CREATE TYPE "CredentialScope" AS ENUM ('PLATFORM', 'MERCHANT');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SUPPORT', 'AUDITOR', 'DEVELOPER');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('ADMIN', 'MERCHANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "refresh_token_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT,
    "callback_url" TEXT,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_domains" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "normalized_origin" TEXT NOT NULL,
    "callback_url" TEXT,
    "webhook_url" TEXT,
    "status" "MerchantDomainStatus" NOT NULL DEFAULT 'ACTIVE',
    "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_api_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "secret_preview" TEXT NOT NULL,
    "secret_iv" TEXT NOT NULL,
    "secret_auth_tag" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "status" "MerchantApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" TEXT NOT NULL,
    "name" "ProviderName" NOT NULL,
    "display_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "supported_currencies" JSONB,
    "supported_countries" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_provider_settings" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "countries" JSONB,
    "currencies" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_provider_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "scope" "CredentialScope" NOT NULL,
    "key_label" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_sessions" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "customer" JSONB NOT NULL,
    "success_url" TEXT NOT NULL,
    "cancel_url" TEXT NOT NULL,
    "callback_url" TEXT NOT NULL,
    "return_url" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'PENDING',
    "provider_session_id" TEXT,
    "provider_reference" TEXT,
    "metadata" JSONB,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "provider_reference" TEXT,
    "raw_response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT,
    "provider_id" TEXT,
    "provider_event_id" TEXT,
    "request_headers" JSONB,
    "raw_payload" JSONB,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callback_logs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "callback_url" TEXT NOT NULL,
    "request_body" JSONB NOT NULL,
    "response_body" JSONB,
    "response_code" INTEGER,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "callback_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "token" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_contact_email_key" ON "merchants"("contact_email");

-- CreateIndex
CREATE INDEX "merchant_domains_merchant_id_environment_status_idx" ON "merchant_domains"("merchant_id", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_domains_merchant_id_environment_normalized_origin_key" ON "merchant_domains"("merchant_id", "environment", "normalized_origin");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_api_keys_client_id_key" ON "merchant_api_keys"("client_id");

-- CreateIndex
CREATE INDEX "merchant_api_keys_merchant_id_environment_status_idx" ON "merchant_api_keys"("merchant_id", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_providers_name_key" ON "payment_providers"("name");

-- CreateIndex
CREATE INDEX "merchant_provider_settings_merchant_id_is_enabled_priority_idx" ON "merchant_provider_settings"("merchant_id", "is_enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_provider_settings_merchant_id_provider_id_key" ON "merchant_provider_settings"("merchant_id", "provider_id");

-- CreateIndex
CREATE INDEX "provider_credentials_provider_id_merchant_id_is_active_idx" ON "provider_credentials"("provider_id", "merchant_id", "is_active");

-- CreateIndex
CREATE INDEX "payment_sessions_merchant_id_status_created_at_idx" ON "payment_sessions"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_sessions_merchant_id_order_id_key" ON "payment_sessions"("merchant_id", "order_id");

-- CreateIndex
CREATE INDEX "transactions_session_id_status_idx" ON "transactions"("session_id", "status");

-- CreateIndex
CREATE INDEX "webhook_logs_provider_event_id_idx" ON "webhook_logs"("provider_event_id");

-- CreateIndex
CREATE INDEX "webhook_logs_provider_id_provider_event_id_idx" ON "webhook_logs"("provider_id", "provider_event_id");

-- CreateIndex
CREATE INDEX "callback_logs_session_id_status_idx" ON "callback_logs"("session_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_key" ON "admin_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "admin_invitations_email_key" ON "admin_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_invitations_token_key" ON "admin_invitations"("token");

-- AddForeignKey
ALTER TABLE "merchant_domains" ADD CONSTRAINT "merchant_domains_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_api_keys" ADD CONSTRAINT "merchant_api_keys_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_provider_settings" ADD CONSTRAINT "merchant_provider_settings_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_provider_settings" ADD CONSTRAINT "merchant_provider_settings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "payment_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "payment_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callback_logs" ADD CONSTRAINT "callback_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "payment_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
