-- #69 workers report runtime status. One entry per runtime a worker is
-- configured for, including ones not installed or whose auth preflight failed,
-- so the Workers page can say "Codex needs a key" instead of hiding it.
-- Sent on register and on every heartbeat. Older rows read back as an empty list.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE worker ADD COLUMN IF NOT EXISTS preflight jsonb NOT NULL DEFAULT '[]'::jsonb;
