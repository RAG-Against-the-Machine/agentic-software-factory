import type { Sql } from '../db/pool.js';

/**
 * The write-only secret sink behind secret://org/<KEY>. A UI-entered provider
 * token is upserted here by name; getOrgSecret is the ONLY read of the value and
 * is reachable only over the internal X-Run-Secret-guarded RPC (never any
 * /api/* browser route). listOrgSecretNames answers "is it set?" without the
 * bytes, so the Providers panel can show set/unset; listOrgSecrets adds updatedAt.
 */
export async function putOrgSecret(sql: Sql, name: string, value: string, by: string | null): Promise<void> {
  await sql`INSERT INTO org_secret (name, value, updated_by, updated_at) VALUES (${name}, ${value}, ${by}, now())
    ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function deleteOrgSecret(sql: Sql, name: string): Promise<void> {
  await sql`DELETE FROM org_secret WHERE name = ${name}`;
}

export async function getOrgSecret(sql: Sql, name: string): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`SELECT value FROM org_secret WHERE name = ${name}`;
  return rows.length ? rows[0].value : null;
}

export async function listOrgSecretNames(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM org_secret ORDER BY name`;
  return rows.map((r) => r.name);
}

/** Names plus when each was last saved — the api dates a UI-saved token's age from updatedAt (#139). */
export async function listOrgSecrets(sql: Sql): Promise<{ name: string; updatedAt: string }[]> {
  const rows = await sql<{ name: string; updatedAt: Date }[]>`SELECT name, updated_at FROM org_secret ORDER BY name`;
  return rows.map((r) => ({ name: r.name, updatedAt: new Date(r.updatedAt).toISOString() }));
}
