-- #179: ad-hoc tasks — a ticket that lives here instead of in a tracker. The api
-- addresses one as `adhoc:<id>` and serves it through a read-only TicketProvider,
-- so dispatch/planner/fleet treat it like any other ticket. Attachments (images,
-- text, PDF) are stored inline as bytea; the api caps their count and size.

CREATE TABLE IF NOT EXISTS adhoc_task (
  id         text PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adhoc_attachment (
  task_id    text NOT NULL REFERENCES adhoc_task (id) ON DELETE CASCADE,
  name       text NOT NULL,
  mime       text NOT NULL,
  size       int  NOT NULL,
  content    bytea NOT NULL,
  position   int  NOT NULL,
  PRIMARY KEY (task_id, name)
);
