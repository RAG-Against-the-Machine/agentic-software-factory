-- Recurring tasks (#188). A recurring_task is an ad-hoc task the factory creates
-- on a schedule. The registry's ticker fires each due row: it copies the title
-- and body into a new adhoc_task, queues it, and moves next_run_at forward.
--
-- recurring_occurrence records each slot that was fired or skipped. Its primary
-- key (recurring_id, slot_at) is what makes firing idempotent across concurrent
-- tickers and restarts. adhoc_id is the task created for the slot, or for a
-- skipped slot the earlier task that was still unfinished.
--
-- adhoc_task.recurring_id has no foreign key, so deleting a schedule leaves the
-- tasks it already created intact.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS recurring_task (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  repo_id     text NOT NULL,
  schedule    jsonb NOT NULL,
  timezone    text NOT NULL,
  paused      boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_task_due ON recurring_task (next_run_at) WHERE NOT paused;

CREATE TABLE IF NOT EXISTS recurring_occurrence (
  recurring_id text NOT NULL REFERENCES recurring_task (id) ON DELETE CASCADE,
  slot_at      timestamptz NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('fired', 'skipped')),
  adhoc_id     text,
  reason       text,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recurring_id, slot_at)
);

ALTER TABLE adhoc_task ADD COLUMN IF NOT EXISTS recurring_id text;
CREATE INDEX IF NOT EXISTS adhoc_task_recurring ON adhoc_task (recurring_id) WHERE recurring_id IS NOT NULL;
