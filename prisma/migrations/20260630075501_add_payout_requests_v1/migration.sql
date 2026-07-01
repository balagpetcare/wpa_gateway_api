-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REJECTED', 'MANUAL_REQUIRED');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK_TRANSFER', 'MOBILE_WALLET', 'MANUAL', 'OTHER');

-- CreateTable
CREATE TABLE "payout_requests" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "settlement_profile_id" TEXT NOT NULL,
    "provider_id" TEXT,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "requested_by_id" TEXT,
    "reviewed_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "provider_payout_ref" TEXT,
    "failure_reason" TEXT,
    "internal_note" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_events" (
    "id" TEXT NOT NULL,
    "payout_request_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" "PayoutStatus",
    "to_status" "PayoutStatus" NOT NULL,
    "note" TEXT,
    "metadata" JSONB,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_requests_merchant_id_currency_status_created_at_idx" ON "payout_requests"("merchant_id", "currency", "status", "created_at");

-- CreateIndex
CREATE INDEX "payout_requests_settlement_profile_id_status_created_at_idx" ON "payout_requests"("settlement_profile_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "payout_requests_provider_id_status_created_at_idx" ON "payout_requests"("provider_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "payout_events_payout_request_id_created_at_idx" ON "payout_events"("payout_request_id", "created_at");

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_settlement_profile_id_fkey" FOREIGN KEY ("settlement_profile_id") REFERENCES "settlement_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_events" ADD CONSTRAINT "payout_events_payout_request_id_fkey" FOREIGN KEY ("payout_request_id") REFERENCES "payout_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_events" ADD CONSTRAINT "payout_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
