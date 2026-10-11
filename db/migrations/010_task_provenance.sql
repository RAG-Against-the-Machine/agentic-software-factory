-- M11 WP3: record WHY each run_task was created, so the RunView can explain a
-- loop and the orchestrator can count EVERY implementer re-run after a review
-- against the loop bound (not just loopBack). Before this, a gate rejection or a
-- needs-human answer cloned the downstream roles without touching
-- review_iterations, so a REQUEST_CHANGES that arrived via a rejected gate was a
-- free extra cycle — how run_d0cd6bf63a9cd6c4 got a third implementer→reviewer
-- pass on maxIterations=2.
--
-- queued_by ∈ plan | loop_back | gate_reject | needs_human_answer | retry
-- queued_reason = the note / verdict line / question that caused it (nullable).

ALTER TABLE run_task ADD COLUMN IF NOT EXISTS queued_by text NOT NULL DEFAULT 'plan';
ALTER TABLE run_task ADD COLUMN IF NOT EXISTS queued_reason text;

CREATE INDEX IF NOT EXISTS run_task_run_queued_by ON run_task (run_id, queued_by);
