-- #139 credential health. The api live-checks each tracker/SCM credential on a
-- timer and on Settings load, and records the result here by setting key.
-- failing_since is stamped on the first failed check and kept until it recovers.
-- alerted_at marks the one notification sent for this failure. A recovery or a
-- re-save of the secret clears both, so the next failure alerts again.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS credential_health (
  key           text PRIMARY KEY,
  ok            boolean NOT NULL,
  reason        text,
  failing_since timestamptz,
  alerted_at    timestamptz,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

-- A credential alert belongs to the org, not to any run.
ALTER TABLE notification ALTER COLUMN run_id DROP NOT NULL;
