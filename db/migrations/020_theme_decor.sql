-- Theme decor picture. A theme may carry one decor picture, stored in
-- theme_image under the slot decor. Decor has no states, so it is only ever
-- stored with the state any (theme-store.ts refuses any other state).
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE theme_image DROP CONSTRAINT IF EXISTS theme_image_slot_check;

ALTER TABLE theme_image ADD CONSTRAINT theme_image_slot_check
  CHECK (slot IN ('orchestrator', 'planner', 'implementer', 'tester', 'reviewer', 'decor'));
