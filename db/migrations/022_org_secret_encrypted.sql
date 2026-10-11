-- #9: org_secret.value is no longer necessarily plaintext. With ASF_SECRET_KEY
-- set on the registry, every value is an AES-256-GCM envelope
-- (enc:v1:<keyId>:<iv>:<tag>:<ciphertext>, the row name bound as AAD), and the
-- registry encrypts any legacy plaintext rows at boot. The key never touches
-- Postgres, so a pg_dump holds ciphertext only and the key must be backed up
-- separately. 006 stays as shipped: applied migrations are never edited.
COMMENT ON COLUMN org_secret.value IS 'AES-256-GCM envelope enc:v1:<keyId>:<iv>:<tag>:<ct> when ASF_SECRET_KEY is set on the registry (see apps/registry/src/settings/secret-crypto.ts), else legacy plaintext';
