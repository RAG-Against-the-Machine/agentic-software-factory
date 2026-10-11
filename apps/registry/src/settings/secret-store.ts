import { resolve } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import {
  type SecretKeyring, keyringFrom, encryptSecret, decryptSecret, isEnvelope, keyFor, SecretKeyError,
} from './secret-crypto.js';

export { SecretKeyError } from './secret-crypto.js';

/**
 * The write-only secret sink behind secret://org/<KEY>. A UI-entered provider
 * token is upserted here by name; getOrgSecret is the ONLY read of the value and
 * is reachable only over the internal X-Run-Secret-guarded RPC (never any
 * /api/* browser route). listOrgSecretNames answers "is it set?" without the
 * bytes, so the Providers panel can show set/unset; listOrgSecrets adds updatedAt.
 *
 * At rest (#9): with ASF_SECRET_KEY set, values are AES-256-GCM envelopes (see
 * secret-crypto.ts); without it they stay plaintext and doctor warns. The key
 * lives only in the registry's environment — never in Postgres, so a pg_dump or
 * a copy of the volume holds ciphertext only.
 */

let cached: { raw: string; ring: SecretKeyring } | null = null;
/** The keyring from the environment, read at call time (testable, import-order-free). */
export function activeKeyring(): SecretKeyring {
  const cur = resolve('ASF_SECRET_KEY');
  const prev = resolve('ASF_SECRET_KEY_PREVIOUS');
  const raw = `${cur}\n${prev}`;
  if (cached?.raw !== raw) cached = { raw, ring: keyringFrom(cur, prev) };
  return cached.ring;
}

export async function putOrgSecret(sql: Sql, name: string, value: string, by: string | null, ring: SecretKeyring = activeKeyring()): Promise<void> {
  const stored = ring.current ? encryptSecret(name, value, ring.current) : value;
  await sql`INSERT INTO org_secret (name, value, updated_by, updated_at) VALUES (${name}, ${stored}, ${by}, now())
    ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function deleteOrgSecret(sql: Sql, name: string): Promise<void> {
  await sql`DELETE FROM org_secret WHERE name = ${name}`;
}

/** null = not set. A value that can't be decrypted THROWS SecretKeyError — never null, never ''. */
export async function getOrgSecret(sql: Sql, name: string, ring: SecretKeyring = activeKeyring()): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`SELECT value FROM org_secret WHERE name = ${name}`;
  return rows.length ? decryptSecret(name, rows[0].value, ring) : null;
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

export interface ReconcileResult {
  /** plaintext rows that were encrypted with the current key */
  encrypted: string[];
  /** rows moved from ASF_SECRET_KEY_PREVIOUS to the current key */
  reencrypted: string[];
  /** rows left in plaintext because no key is configured */
  plaintext: string[];
  /** rows no configured key can open (wrong/missing key, or tampered) — left untouched */
  undecryptable: string[];
}

/**
 * Bring every row to the current key, at registry boot. Idempotent, one
 * transaction, rows locked, so two registries booting together can't
 * double-encrypt. updated_at is deliberately NOT bumped: it is the token's age
 * (credential health), and re-wrapping the bytes doesn't make a token younger.
 * Undecryptable rows are never rewritten or deleted.
 */
export async function reconcileOrgSecrets(sql: Sql, ring: SecretKeyring = activeKeyring()): Promise<ReconcileResult> {
  const out: ReconcileResult = { encrypted: [], reencrypted: [], plaintext: [], undecryptable: [] };
  await sql.begin(async (tx) => {
    const rows = await tx<{ name: string; value: string }[]>`SELECT name, value FROM org_secret ORDER BY name FOR UPDATE`;
    for (const r of rows) {
      if (!isEnvelope(r.value)) {
        if (!ring.current) { out.plaintext.push(r.name); continue; }
        await tx`UPDATE org_secret SET value = ${encryptSecret(r.name, r.value, ring.current)} WHERE name = ${r.name}`;
        out.encrypted.push(r.name);
        continue;
      }
      const key = keyFor(r.value, ring);
      if (!key) { out.undecryptable.push(r.name); continue; }
      let plain: string;
      try { plain = decryptSecret(r.name, r.value, ring); } catch (err) {
        if (err instanceof SecretKeyError) { out.undecryptable.push(r.name); continue; }
        throw err;
      }
      if (ring.current && key.id !== ring.current.id) {
        await tx`UPDATE org_secret SET value = ${encryptSecret(r.name, plain, ring.current)} WHERE name = ${r.name}`;
        out.reencrypted.push(r.name);
      }
    }
  });
  return out;
}

export type OrgSecretState = 'none' | 'encrypted' | 'plaintext' | 'key-mismatch';
export interface OrgSecretStatus {
  state: OrgSecretState;
  /** fingerprint of ASF_SECRET_KEY (not the key), null when unset */
  keyId: string | null;
  total: number;
  plaintext: number;
  undecryptable: number;
}

/**
 * Cheap at-rest summary for /health and `asf doctor`: counts only, never names
 * or values. 'key-mismatch' wins over 'plaintext' — a token that can't be
 * opened is the more urgent problem. Decrypts each envelope, so a tampered row
 * counts as undecryptable, not merely "wrong key".
 */
export async function orgSecretStatus(sql: Sql, ring: SecretKeyring = activeKeyring()): Promise<OrgSecretStatus> {
  const rows = await sql<{ name: string; value: string }[]>`SELECT name, value FROM org_secret`;
  let plaintext = 0; let undecryptable = 0;
  for (const r of rows) {
    if (!isEnvelope(r.value)) { plaintext++; continue; }
    try { decryptSecret(r.name, r.value, ring); } catch { undecryptable++; }
  }
  const state: OrgSecretState = rows.length === 0 ? 'none' : undecryptable ? 'key-mismatch' : plaintext ? 'plaintext' : 'encrypted';
  return { state, keyId: ring.current?.id ?? null, total: rows.length, plaintext, undecryptable };
}
