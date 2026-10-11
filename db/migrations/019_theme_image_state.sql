-- Crew pictures per state (M13). A member can have a picture for each state
-- it shows in: idle (not started), working (has the work), done (finished).
-- The state any is the plain picture, used for every state without its own.
-- Every picture stored before this migration is a plain one, so it keeps
-- showing exactly where it did.
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
ALTER TABLE theme_image ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'any'
  CHECK (state IN ('any', 'idle', 'working', 'done'));

ALTER TABLE theme_image DROP CONSTRAINT IF EXISTS theme_image_pkey;

ALTER TABLE theme_image ADD CONSTRAINT theme_image_pkey PRIMARY KEY (theme_id, slot, state);
