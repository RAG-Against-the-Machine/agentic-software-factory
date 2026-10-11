-- Applied by the registry in filename order. Additive only: never edit one that shipped.
-- WP B (configurable-pipeline plan): record how delivery concluded so the run can
-- end cleanly as "succeeded (awaiting external merge)" when ASF opens the MR/PR
-- but does not merge it (a human reviews + merges in the SCM system).

ALTER TABLE agent_run ADD COLUMN IF NOT EXISTS delivery_outcome text;
