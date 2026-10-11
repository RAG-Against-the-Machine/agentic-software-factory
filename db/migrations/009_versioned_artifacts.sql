-- M11 WP1: versioned run artifacts. Before this, run_artifact was
-- PRIMARY KEY (run_id, name), so a role that ran three times (a review loop)
-- left ONE row — every review.md overwrote the last, and the repeated verdict
-- that drove the loop was invisible. Keep one row PER PRODUCING TASK instead,
-- so the UI can show plan.md v1/v2, review.md #1/#2/#3, with diffs.
--
-- Additive and backward-safe: existing rows keep task_id NULL (legacy, one per
-- name); new writes carry task_id + attempt. Readers that want "the current
-- one" use the newest row per name (latest_run_artifact view below).

ALTER TABLE run_artifact ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE run_artifact ADD COLUMN IF NOT EXISTS task_id text REFERENCES run_task(id);
ALTER TABLE run_artifact ADD COLUMN IF NOT EXISTS attempt int;
ALTER TABLE run_artifact ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent';
ALTER TABLE run_artifact ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Backfill ids for the pre-existing single-row-per-name rows so id can be the PK.
UPDATE run_artifact SET id = 'artf_legacy_' || md5(run_id || ':' || name) WHERE id IS NULL;

-- Swap the identity: drop the (run_id, name) primary key, make id the key.
ALTER TABLE run_artifact DROP CONSTRAINT IF EXISTS run_artifact_pkey;
ALTER TABLE run_artifact ALTER COLUMN id SET NOT NULL;
ALTER TABLE run_artifact ADD PRIMARY KEY (id);

-- One row per (run, name, producing task). A NULL task_id (legacy + human edits
-- that predate a task link) collapses to a single "no task" slot per name via
-- coalesce, so re-writing the same task's artifact upserts rather than piling up.
CREATE UNIQUE INDEX IF NOT EXISTS run_artifact_run_name_task
  ON run_artifact (run_id, name, coalesce(task_id, ''));
CREATE INDEX IF NOT EXISTS run_artifact_run_created ON run_artifact (run_id, created_at);

-- The newest version per (run, name) — what every existing reader wants (the
-- gate check, publish, prior-artifact loading, the current UI list).
CREATE OR REPLACE VIEW latest_run_artifact AS
  SELECT DISTINCT ON (run_id, name) run_id, name, content, task_id, attempt, source, created_at, updated_at
    FROM run_artifact
   ORDER BY run_id, name, created_at DESC, updated_at DESC;
