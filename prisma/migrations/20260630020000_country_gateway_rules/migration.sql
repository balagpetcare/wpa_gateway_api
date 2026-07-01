-- CreateEnum
CREATE TYPE "InternationalDisplayPolicy" AS ENUM (
  'SHOW_FIRST',
  'SHOW_AFTER_LOCAL',
  'HIDE_WHEN_LOCAL_EXISTS',
  'HIDE_ALWAYS'
);

-- CreateTable
CREATE TABLE "country_gateway_rules" (
  "id"                                    TEXT NOT NULL,
  "country_code"                          TEXT NOT NULL,
  "country_name"                          TEXT NOT NULL,
  "region_code"                           TEXT,
  "default_currency"                      TEXT NOT NULL,
  "local_gateways_enabled"                BOOLEAN NOT NULL DEFAULT true,
  "international_gateways_enabled"        BOOLEAN NOT NULL DEFAULT true,
  "international_display_policy"          "InternationalDisplayPolicy" NOT NULL,
  "fallback_to_international_when_no_local" BOOLEAN NOT NULL DEFAULT true,
  "is_active"                             BOOLEAN NOT NULL DEFAULT true,
  "notes"                                 TEXT,
  "created_at"                            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "country_gateway_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "country_gateway_rules_country_code_key" ON "country_gateway_rules"("country_code");

-- CreateIndex
CREATE INDEX "country_gateway_rules_is_active_region_code_idx" ON "country_gateway_rules"("is_active", "region_code");
