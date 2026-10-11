-- Third-party skills. An operator adds a SKILL.md bundle (from a GitHub or
-- GitLab repository) for the fleet to use. The files are stored as text in
-- files (a JSON array of path and content), pinned to the commit they were
-- fetched at. A skill is off until an operator enables it, and then only the
-- roles in roles get it. The registry checks the limits (file count, total
-- size, extensions, relative paths) before it writes a row (skill-store.ts).
--
-- NOTE keep comments in this file free of the semicolon character (the migration
-- runner splits one simple-protocol string on semicolons and does not skip
-- comments).
CREATE TABLE IF NOT EXISTS skill (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name         text NOT NULL,
  description  text NOT NULL,
  source_url   text NOT NULL,
  source_ref   text NOT NULL,
  commit_sha   text NOT NULL,
  files        jsonb NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  roles        text[] NOT NULL DEFAULT ARRAY['planner', 'implementer', 'tester', 'reviewer']
               CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['planner', 'implementer', 'tester', 'reviewer']),
  added_by     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
