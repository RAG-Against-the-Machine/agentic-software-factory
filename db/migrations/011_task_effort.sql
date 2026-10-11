-- Per-role reasoning effort (claude -p --effort <level>), stored on the task so a
-- run's audit trail shows the effort each role ran at alongside its model, and a
-- re-queued task carries it forward. Additive; NULL = the CLI default.
ALTER TABLE run_task ADD COLUMN IF NOT EXISTS effort text;
