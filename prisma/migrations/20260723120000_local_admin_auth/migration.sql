CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

CREATE TYPE "AdminRole_new" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN', 'OPERATIONS_ADMIN', 'VIEWER');

ALTER TABLE "admin_users"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMP(3),
  ADD COLUMN "last_login_at" TIMESTAMP(3),
  ADD COLUMN "last_login_ip" TEXT,
  ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "created_by_id" TEXT;

UPDATE "admin_users"
SET
  "name" = COALESCE(NULLIF(split_part("email", '@', 1), ''), 'Gateway Admin'),
  "status" = CASE WHEN "is_active" = true THEN 'ACTIVE'::"AdminUserStatus" ELSE 'SUSPENDED'::"AdminUserStatus" END;

ALTER TABLE "admin_users"
  ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "admin_users"
  ALTER COLUMN "role" TYPE "AdminRole_new"
  USING (
    CASE
      WHEN "role"::text = 'MANAGER' THEN 'OPERATIONS_ADMIN'::"AdminRole_new"
      WHEN "role"::text IN ('SUPPORT', 'AUDITOR', 'DEVELOPER') THEN 'VIEWER'::"AdminRole_new"
      ELSE "role"::text::"AdminRole_new"
    END
  );

DROP TABLE IF EXISTS "admin_invitations";

DROP TYPE "AdminRole";
ALTER TYPE "AdminRole_new" RENAME TO "AdminRole";

DROP INDEX IF EXISTS "admin_users_central_user_id_key";

ALTER TABLE "admin_users"
  DROP COLUMN IF EXISTS "central_user_id",
  DROP COLUMN IF EXISTS "is_active",
  DROP COLUMN IF EXISTS "refresh_token_hash";

ALTER TABLE "admin_users"
  ADD CONSTRAINT "admin_users_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "admin_sessions"
  ADD COLUMN "session_token_id" TEXT,
  ADD COLUMN "refresh_token_hash" TEXT,
  ADD COLUMN "remember_me" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_used_at" TIMESTAMP(3),
  ADD COLUMN "revoked_at" TIMESTAMP(3),
  ADD COLUMN "replaced_by_session_id" TEXT,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "admin_sessions"
SET
  "session_token_id" = "id",
  "refresh_token_hash" = COALESCE("token", 'legacy-session-invalidated'),
  "last_used_at" = "created_at",
  "revoked_at" = CURRENT_TIMESTAMP,
  "updated_at" = CURRENT_TIMESTAMP;

ALTER TABLE "admin_sessions"
  ALTER COLUMN "session_token_id" SET NOT NULL,
  ALTER COLUMN "refresh_token_hash" SET NOT NULL;

DROP INDEX IF EXISTS "admin_sessions_token_key";

ALTER TABLE "admin_sessions"
  DROP COLUMN IF EXISTS "token";

CREATE UNIQUE INDEX "admin_sessions_session_token_id_key" ON "admin_sessions"("session_token_id");
CREATE INDEX "admin_sessions_admin_id_expires_at_idx" ON "admin_sessions"("admin_id", "expires_at");
CREATE INDEX "admin_sessions_admin_id_revoked_at_idx" ON "admin_sessions"("admin_id", "revoked_at");

ALTER TABLE "admin_sessions"
  ADD CONSTRAINT "admin_sessions_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "password_reset_tokens" (
  "id" TEXT NOT NULL,
  "admin_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_admin_id_expires_at_idx" ON "password_reset_tokens"("admin_id", "expires_at");

ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_audit_logs" (
  "id" TEXT NOT NULL,
  "actor_admin_id" TEXT,
  "target_admin_id" TEXT,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "ip_address" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_actor_admin_id_created_at_idx" ON "admin_audit_logs"("actor_admin_id", "created_at");
CREATE INDEX "admin_audit_logs_target_admin_id_created_at_idx" ON "admin_audit_logs"("target_admin_id", "created_at");

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_actor_admin_id_fkey"
  FOREIGN KEY ("actor_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_target_admin_id_fkey"
  FOREIGN KEY ("target_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
