-- Global Super Admin, Stage 1: additive, nullable link from a local gateway
-- AdminUser row to the WPA Central Auth identity that owns it. Never set
-- for ordinary local gateway admin accounts. No existing rows are modified.
ALTER TABLE "admin_users" ADD COLUMN "central_user_id" TEXT;

CREATE UNIQUE INDEX "admin_users_central_user_id_key" ON "admin_users"("central_user_id");
