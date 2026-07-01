-- AlterTable: add checkout and routing fields to payment_providers
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "checkout_display_name"     TEXT,
  ADD COLUMN IF NOT EXISTS "checkout_description"      TEXT,
  ADD COLUMN IF NOT EXISTS "supported_regions"         JSONB,
  ADD COLUMN IF NOT EXISTS "excluded_countries"        JSONB,
  ADD COLUMN IF NOT EXISTS "allow_currency_conversion" BOOLEAN NOT NULL DEFAULT false;
