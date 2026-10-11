-- M3: gate decisions and the artifacts a run produces (plan.md, review.md, ...).
-- Additive only.

-- A gate the orchestrator reached. One row per (run, gate) occurrence; the
-- decision arrives from the api when a human answers, or is auto-recorded.
CREATE TABLE IF NOT EXISTS run_gate (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES agent_run(id),
  gate_name   text NOT NULL,          -- after_plan | before_change_request | before_merge | after_role:<role>
  mode        text NOT NULL,          -- required | notify | auto (as resolved for this run)
  state       text NOT NULL,          -- open | approved | rejected | auto | abandoned
  after_task  text REFERENCES run_task(id),
  artifact    text,                   -- the artifact the human reviews at this gate (e.g. plan.md contents)
  decided_by  text,
  note        text,
  edited_artifact text,               -- a human-edited version of the artifact (e.g. an edited plan)
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS run_gate_open ON run_gate (run_id) WHERE state = 'open';

-- Artifacts a run has produced, mirrored from the worker so the UI and the
-- publish step can read them without touching a worker's disk.
CREATE TABLE IF NOT EXISTS run_artifact (
  run_id      text NOT NULL REFERENCES agent_run(id),
  name        text NOT NULL,          -- plan.md, test-report.md, review.md
  content     text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, name)
);

-- Iteration counter for the review->implementer loop, so it is bounded.
ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS review_iterations int NOT NULL DEFAULT 0;
