-- Themes (M12). A theme is how the agent crew looks and talks: names, quips,
-- an accent colour and one picture per slot (the orchestrator plus the four
-- roles). Built-in themes (classic, hive) ship in code and are never stored
-- here. theme holds uploaded (custom) themes only, and the registry refuses an
-- id that a built-in theme uses.
--
-- theme_image holds an operator's pictures for ANY theme, built-in or custom,
-- which is why theme_id has no foreign key. Deleting a custom theme deletes its
-- pictures in the same transaction (theme-store.ts).
--
-- The existing agent avatars are copied onto the classic theme, the default, so
-- nobody loses the pictures they uploaded. agent_avatar stays (migrations are
-- additive) but nothing reads it any more.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS theme (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  manifest    jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS theme_image (
  theme_id    text NOT NULL CHECK (theme_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  slot        text NOT NULL CHECK (slot IN ('orchestrator', 'planner', 'implementer', 'tester', 'reviewer')),
  mime        text NOT NULL,
  bytes       bytea NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, slot)
);

INSERT INTO theme_image (theme_id, slot, mime, bytes, updated_by, updated_at)
  SELECT 'classic', role, mime, bytes, updated_by, updated_at FROM agent_avatar
  ON CONFLICT (theme_id, slot) DO NOTHING;
