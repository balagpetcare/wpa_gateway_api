ALTER TABLE "payment_sessions" ADD COLUMN "reference" TEXT;
UPDATE "payment_sessions" SET "reference" = "id" WHERE "reference" IS NULL;
ALTER TABLE "payment_sessions" ALTER COLUMN "reference" SET NOT NULL;

ALTER TABLE "payment_sessions" ADD COLUMN "merchant_api_key_id" TEXT;
ALTER TABLE "payment_sessions" ADD COLUMN "environment" "MerchantEnvironment" NOT NULL DEFAULT 'SANDBOX';
ALTER TABLE "payment_sessions" ADD COLUMN "description" TEXT;
ALTER TABLE "payment_sessions" ALTER COLUMN "cancel_url" DROP NOT NULL;
ALTER TABLE "payment_sessions" ADD COLUMN "webhook_url" TEXT;
ALTER TABLE "payment_sessions" ADD COLUMN "request_hash" TEXT;
ALTER TABLE "payment_sessions" ADD COLUMN "request_ip" TEXT;
ALTER TABLE "payment_sessions" ADD COLUMN "request_user_agent" TEXT;

DROP INDEX IF EXISTS "payment_sessions_merchant_id_order_id_key";
CREATE UNIQUE INDEX "payment_sessions_merchant_id_environment_order_id_key" ON "payment_sessions" ("merchant_id", "environment", "order_id");
CREATE UNIQUE INDEX "payment_sessions_reference_key" ON "payment_sessions" ("reference");

CREATE INDEX "payment_sessions_merchant_id_environment_status_created_at_idx" ON "payment_sessions" ("merchant_id", "environment", "status", "created_at");
CREATE INDEX "payment_sessions_merchant_api_key_id_idx" ON "payment_sessions" ("merchant_api_key_id");

ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_merchant_api_key_id_fkey" FOREIGN KEY ("merchant_api_key_id") REFERENCES "merchant_api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
