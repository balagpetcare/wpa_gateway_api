-- Align migration history with the current schema state that was previously
-- applied directly to the database.

-- AddColumn
ALTER TABLE "payment_sessions"
  ADD COLUMN IF NOT EXISTS "base_amount" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payment_providers_provider_code_environment_key"
  ON "payment_providers"("provider_code", "environment");

-- DropIndex
DROP INDEX IF EXISTS "payment_sessions_merchant_api_key_id_idx";

-- DropIndex
DROP INDEX IF EXISTS "payment_sessions_merchant_id_status_created_at_idx";

-- RenameIndex
ALTER INDEX IF EXISTS "credential_profiles_provider_id_environment_scope_merchant_id_l"
  RENAME TO "credential_profiles_provider_id_environment_scope_merchant__key";

-- RenameIndex
ALTER INDEX IF EXISTS "currency_rates_base_currency_quote_currency_is_active_effecti_i"
  RENAME TO "currency_rates_base_currency_quote_currency_is_active_effec_idx";

-- RenameIndex
ALTER INDEX IF EXISTS "gateway_routing_rules_country_code_currency_code_purpose_provid"
  RENAME TO "gateway_routing_rules_country_code_currency_code_purpose_pr_key";
