-- Planner-proposed splits. A plan that is too big for one pull request carries
-- an asf-split block. When the plan is approved the registry creates each part
-- as an ad-hoc task, queues it, and the parent run ends as delivery_outcome split.
--
-- adhoc_task.parent_run_id + part link a sub-task to the run that split it.
-- work_queue.depends_on lists the ticket ids whose pull requests must be MERGED
-- before the entry may be dispatched (the scheduler checks agent_run for a
-- merged delivery or a merged change request).
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE adhoc_task ADD COLUMN IF NOT EXISTS parent_run_id text;
ALTER TABLE adhoc_task ADD COLUMN IF NOT EXISTS part int;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS depends_on jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS adhoc_task_parent_run ON adhoc_task (parent_run_id) WHERE parent_run_id IS NOT NULL;
