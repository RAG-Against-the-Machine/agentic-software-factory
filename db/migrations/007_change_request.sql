-- Applied by the registry in filename order. Additive only: never edit one that shipped.
-- WP A (configurable-pipeline plan): make the opened change request (MR/PR) a
-- first-class run field. 001 already reserved change_request_url; add its number
-- and state so the run row is the single source of truth for the created MR/PR
-- (previously the URL lived only in the change_request:opened event).

ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS change_request_number integer;
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS change_request_state text;
