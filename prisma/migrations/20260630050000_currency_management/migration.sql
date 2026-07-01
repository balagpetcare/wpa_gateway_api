-- CreateEnum: RateSource, RateUpdateMode, RoundingMode
CREATE TYPE "RateSource" AS ENUM ('MANUAL', 'PROVIDER_API', 'SYSTEM');
CREATE TYPE "RateUpdateMode" AS ENUM ('MANUAL', 'AUTOMATIC', 'HYBRID');
CREATE TYPE "RoundingMode" AS ENUM ('NONE', 'ROUND_2_DECIMALS', 'ROUND_NEAREST_INTEGER', 'ROUND_UP', 'ROUND_DOWN');

-- CreateTable: currency_rates
CREATE TABLE "currency_rates" (
  "id"                  TEXT NOT NULL,
  "base_currency"       TEXT NOT NULL,
  "quote_currency"      TEXT NOT NULL,
  "rate"                DECIMAL(20,8) NOT NULL,
  "source"              "RateSource" NOT NULL,
  "provider_name"       TEXT,
  "effective_from"      TIMESTAMP(3) NOT NULL,
  "effective_to"        TIMESTAMP(3),
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "created_by_admin_id" TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "currency_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "currency_rates_base_currency_quote_currency_is_active_effecti_idx"
  ON "currency_rates"("base_currency", "quote_currency", "is_active", "effective_from");

ALTER TABLE "currency_rates"
  ADD CONSTRAINT "currency_rates_created_by_admin_id_fkey"
  FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: currency_settings
CREATE TABLE "currency_settings" (
  "id"                      TEXT NOT NULL,
  "default_base_currency"   TEXT NOT NULL DEFAULT 'USD',
  "rate_update_mode"        "RateUpdateMode" NOT NULL DEFAULT 'MANUAL',
  "rate_markup_percent"     DECIMAL(5,2) NOT NULL DEFAULT 0,
  "rounding_mode"           "RoundingMode" NOT NULL DEFAULT 'ROUND_2_DECIMALS',
  "stale_rate_limit_minutes" INTEGER NOT NULL DEFAULT 60,
  "is_active"               BOOLEAN NOT NULL DEFAULT true,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "currency_settings_pkey" PRIMARY KEY ("id")
);

-- AlterTable: payment_sessions — add conversion tracking columns
ALTER TABLE "payment_sessions"
  ADD COLUMN IF NOT EXISTS "charged_amount"          BIGINT,
  ADD COLUMN IF NOT EXISTS "charged_currency"        TEXT,
  ADD COLUMN IF NOT EXISTS "exchange_rate"           DECIMAL(20,8),
  ADD COLUMN IF NOT EXISTS "exchange_rate_source"    TEXT,
  ADD COLUMN IF NOT EXISTS "exchange_rate_timestamp" TIMESTAMP(3);
