-- Agent avatars. One image per role for the whole factory (org-wide), uploaded
-- from Settings as a zip and shown on the Run page. Only PNG, JPEG, GIF and WebP
-- are accepted (no SVG, which can carry script). The api checks type and size
-- before anything reaches this table.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS agent_avatar (
  role        text PRIMARY KEY CHECK (role IN ('planner', 'implementer', 'tester', 'reviewer')),
  mime        text NOT NULL,
  bytes       bytea NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
