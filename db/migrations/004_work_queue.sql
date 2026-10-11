-- M6 WP6.1 work queue columns. M1 (001_schema.sql) reserved a minimal work_queue
-- table (id, ticket_provider, ticket_id, position, mode, added_by, added_at,
-- UNIQUE(ticket_provider, ticket_id)). This migration grows it into the full
-- queue the scheduler drives: the ticket handle, per-entry dispatch overrides,
-- lifecycle state, the resulting run, and the batch an entry belongs to.
--
-- NOTE keep comments in this file free of the semicolon character. The file is
-- applied as one simple-protocol multi-statement string, and a semicolon inside
-- a comment would split a statement early.

ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS ticket_key    text NOT NULL DEFAULT '';
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS repo_id       text;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS team_name     text;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS max_cost_usd  numeric;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS batch_id      text NOT NULL DEFAULT '';
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS state         text NOT NULL DEFAULT 'queued';
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS run_id        text;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS reason        text;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

-- position was int in the stub. Reordering slots an entry at the midpoint of two
-- neighbours, which needs a fractional position, so widen it.
ALTER TABLE work_queue ALTER COLUMN position TYPE double precision;

-- The stub had a plain UNIQUE(ticket_provider, ticket_id) that would forbid ever
-- re-queuing a ticket after its run finished. Replace it with a partial unique
-- index that only forbids TWO LIVE (queued) entries for the same ticket.
ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_ticket_provider_ticket_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS work_queue_one_live_per_ticket
  ON work_queue (ticket_provider, ticket_id) WHERE state = 'queued';

-- The scheduler scans queued entries oldest position first, so index that path.
CREATE INDEX IF NOT EXISTS work_queue_queued_idx ON work_queue (state, position) WHERE state = 'queued';
