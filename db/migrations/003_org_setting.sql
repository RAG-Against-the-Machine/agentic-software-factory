-- M7: org-tier settings, edited from the UI. Keys and allowed tiers are declared
-- in packages/shared/src/settings.ts; the registry refuses a key the catalogue
-- does not allow at the org tier.
CREATE TABLE IF NOT EXISTS org_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- M7 fleet panel (WP 7.4): a worker advertises how its agent authenticates so
-- the "why is my run queued?" view can show subscription vs api-key vs vertex/bedrock.
ALTER TABLE worker ADD COLUMN IF NOT EXISTS auth_mode text;
