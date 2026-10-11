-- White-label WP B: a DB-backed secret sink. A UI-entered provider token is
-- stored write-only here (never echoed to the browser) and read only inside the
-- api at provider-build time, addressed by the reserved pointer secret://org/<KEY>.
-- The org_setting row for that key holds only the pointer string; the bytes live
-- here. Plaintext at rest, like most self-host apps — a hardened deploy keeps
-- SECRETS_SOURCE=gcp/aws and sets tokens via env (env tier wins over org).
CREATE TABLE IF NOT EXISTS org_secret (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
