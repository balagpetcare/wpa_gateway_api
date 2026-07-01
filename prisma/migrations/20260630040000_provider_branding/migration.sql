-- AlterTable: add icon_url and brand_color to payment_providers
ALTER TABLE "payment_providers"
  ADD COLUMN IF NOT EXISTS "icon_url"    TEXT,
  ADD COLUMN IF NOT EXISTS "brand_color" TEXT;
