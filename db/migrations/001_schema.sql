-- Applied by the registry in filename order. Additive only: never edit one that shipped.

CREATE TABLE IF NOT EXISTS agent_run (
  id                  text PRIMARY KEY,
  ticket_id           text NOT NULL,
  ticket_key          text NOT NULL,
  ticket_provider     text NOT NULL,
  state               text NOT NULL,
  team_name           text NOT NULL,
  team                jsonb NOT NULL,          -- the TeamTemplate as dispatched
  gates               jsonb NOT NULL,          -- resolved gate config at dispatch (audit trail)
  repo_id             text,
  worktree_path       text,
  branch_name         text,
  change_request_url  text,
  cost_usd            numeric NOT NULL DEFAULT 0,
  max_cost_usd        numeric NOT NULL,
  dispatched_by       text,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  last_event_at       timestamptz,
  cancel_requested_at timestamptz,
  finished_at         timestamptz
);
-- One live run per ticket. The second insert fails in the database, not in a check that raced.
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_live_ticket
  ON agent_run (ticket_provider, ticket_id)
  WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'halted');

CREATE TABLE IF NOT EXISTS run_task (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES agent_run(id),
  role        text NOT NULL,
  seq         int  NOT NULL,
  state       text NOT NULL,       -- pending | running | awaiting_gate | done | failed | needs_human | skipped
  attempt     int  NOT NULL DEFAULT 1,
  input_ref   text,
  output_ref  text,
  worker_id   text,
  runtime     text,
  model       text,
  cost_usd    numeric NOT NULL DEFAULT 0,
  gate_checked boolean NOT NULL DEFAULT false,
  started_at  timestamptz,
  finished_at timestamptz,
  reason      text
);
CREATE INDEX IF NOT EXISTS run_task_claim ON run_task (state, seq) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS run_events (
  id       bigserial PRIMARY KEY,
  run_id   text NOT NULL REFERENCES agent_run(id),
  task_id  text REFERENCES run_task(id),
  seq      int  NOT NULL,
  kind     text NOT NULL,
  source   text NOT NULL,
  payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
  at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS worker (
  id              text PRIMARY KEY,
  host            text NOT NULL,
  runtimes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_concurrent  int  NOT NULL DEFAULT 1,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  last_heartbeat  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_queue (
  id          bigserial PRIMARY KEY,
  ticket_provider text NOT NULL,
  ticket_id   text NOT NULL,
  position    int  NOT NULL,
  mode        text NOT NULL DEFAULT 'serial',   -- serial | parallel
  added_by    text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_provider, ticket_id)
);

CREATE TABLE IF NOT EXISTS team_template (
  name        text PRIMARY KEY,
  scope       text NOT NULL DEFAULT 'global',   -- global | project:<id>
  template    jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
