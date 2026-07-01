-- Add regionName, source, isSystemSeeded fields to country_gateway_rules

ALTER TABLE "country_gateway_rules"
  ADD COLUMN IF NOT EXISTS "region_name"       TEXT,
  ADD COLUMN IF NOT EXISTS "source"            TEXT NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN IF NOT EXISTS "is_system_seeded"  BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "country_gateway_rules_source_is_system_seeded_idx"
  ON "country_gateway_rules" ("source", "is_system_seeded");
