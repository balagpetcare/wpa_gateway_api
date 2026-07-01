-- CreateEnum
CREATE TYPE "CredentialTestStatus" AS ENUM ('NOT_TESTED', 'PASSED', 'FAILED', 'BLOCKED');

-- AlterTable
ALTER TABLE "credential_profiles" ADD COLUMN     "last_test_details" JSONB,
ADD COLUMN     "last_test_environment" "MerchantEnvironment",
ADD COLUMN     "last_test_message" TEXT,
ADD COLUMN     "last_test_status" "CredentialTestStatus",
ADD COLUMN     "last_tested_at" TIMESTAMP(3),
ADD COLUMN     "live_verified_at" TIMESTAMP(3),
ADD COLUMN     "sandbox_verified_at" TIMESTAMP(3),
ADD COLUMN     "verification_expires_at" TIMESTAMP(3);
