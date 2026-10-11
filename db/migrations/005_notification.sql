-- M6 WP6.3 notifications. The orchestrator records a notification the moment a
-- run needs a human (a required gate opens, a task parks at needs_human) or a
-- run ends (succeeded, failed, halted). The web inbox reads this table; the
-- Telegram sink delivers rows it has not sent yet and stamps delivered_at.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS notification (
  id           bigserial PRIMARY KEY,
  run_id       text NOT NULL REFERENCES agent_run(id),
  gate_id      text,
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  actions      jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  delivered_at timestamptz
);

-- The inbox lists newest first and highlights unread.
CREATE INDEX IF NOT EXISTS notification_unread_idx ON notification (created_at DESC) WHERE read_at IS NULL;

-- The Telegram sink polls for rows it has not delivered yet.
CREATE INDEX IF NOT EXISTS notification_undelivered_idx ON notification (id) WHERE delivered_at IS NULL;
