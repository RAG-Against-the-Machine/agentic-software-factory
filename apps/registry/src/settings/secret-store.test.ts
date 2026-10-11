import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { putOrgSecret, deleteOrgSecret, getOrgSecret, listOrgSecretNames, reconcileOrgSecrets, orgSecretStatus, SecretKeyError } from './secret-store.js';
import { keyringFrom } from './secret-crypto.js';
import { dbAvailable, testDb } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('secretstore'); });
after(async () => { if (db) await db.close(); });

test('round-trips a value, upserts, lists names only, and deletes', { skip }, async () => {
  assert.equal(await getOrgSecret(db.sql, 'JIRA_API_TOKEN'), null);
  assert.deepEqual(await listOrgSecretNames(db.sql), []);

  await putOrgSecret(db.sql, 'JIRA_API_TOKEN', 'tok-abc', 'jon');
  assert.equal(await getOrgSecret(db.sql, 'JIRA_API_TOKEN'), 'tok-abc');
  assert.deepEqual(await listOrgSecretNames(db.sql), ['JIRA_API_TOKEN']);

  // upsert overwrites the value, not inserts a second row
  await putOrgSecret(db.sql, 'JIRA_API_TOKEN', 'tok-xyz', 'jon');
  assert.equal(await getOrgSecret(db.sql, 'JIRA_API_TOKEN'), 'tok-xyz');
  assert.deepEqual(await listOrgSecretNames(db.sql), ['JIRA_API_TOKEN']);

  await putOrgSecret(db.sql, 'GITHUB_TOKEN', 'gh-1', null);
  assert.deepEqual(await listOrgSecretNames(db.sql), ['GITHUB_TOKEN', 'JIRA_API_TOKEN']);

  await deleteOrgSecret(db.sql, 'JIRA_API_TOKEN');
  assert.equal(await getOrgSecret(db.sql, 'JIRA_API_TOKEN'), null);
  assert.deepEqual(await listOrgSecretNames(db.sql), ['GITHUB_TOKEN']);
});

// ---- at-rest encryption (#9) ----------------------------------------------
const hex = () => randomBytes(32).toString('hex');
const NONE = keyringFrom('', '');
async function raw(name: string): Promise<{ value: string; updatedAt: Date } | undefined> {
  const r = await db.sql<{ value: string; updatedAt: Date }[]>`SELECT value, updated_at FROM org_secret WHERE name = ${name}`;
  return r[0];
}
async function clear() { await db.sql`DELETE FROM org_secret`; }

test('with a key, the row holds only ciphertext and reads back the value', { skip }, async () => {
  await clear();
  const ring = keyringFrom(hex(), '');
  await putOrgSecret(db.sql, 'GITHUB_TOKEN', 'ghp_plain_123', 'ada', ring);
  const r = await raw('GITHUB_TOKEN');
  assert.ok(r && r.value.startsWith('enc:v1:') && !r.value.includes('ghp_plain_123'));
  assert.equal(await getOrgSecret(db.sql, 'GITHUB_TOKEN', ring), 'ghp_plain_123');
  assert.deepEqual(await orgSecretStatus(db.sql, ring), { state: 'encrypted', keyId: ring.current!.id, total: 1, plaintext: 0, undecryptable: 0 });
  // a pg_dump-level reader (no key) gets an error, never the value and never "unset"
  await assert.rejects(getOrgSecret(db.sql, 'GITHUB_TOKEN', NONE), SecretKeyError);
});

test('no key: still works on plaintext, and the status says so', { skip }, async () => {
  await clear();
  await putOrgSecret(db.sql, 'TRELLO_TOKEN', 't-1', null, NONE);
  assert.equal((await raw('TRELLO_TOKEN'))!.value, 't-1');
  assert.equal(await getOrgSecret(db.sql, 'TRELLO_TOKEN', NONE), 't-1');
  const r = await reconcileOrgSecrets(db.sql, NONE);
  assert.deepEqual(r, { encrypted: [], reencrypted: [], plaintext: ['TRELLO_TOKEN'], undecryptable: [] });
  assert.equal((await orgSecretStatus(db.sql, NONE)).state, 'plaintext');
  assert.equal((await orgSecretStatus(db.sql, NONE)).keyId, null);
  await clear();
  assert.equal((await orgSecretStatus(db.sql, NONE)).state, 'none');
});

test('upgrade: boot encrypts existing plaintext rows, keeps updated_at, and is idempotent', { skip }, async () => {
  await clear();
  await db.sql`INSERT INTO org_secret (name, value, updated_by, updated_at) VALUES
    ('GITHUB_TOKEN', 'gh-old', 'ada', '2026-01-02T03:04:05Z'), ('OPENAI_API_KEY', 'sk-old', null, '2026-02-03T00:00:00Z')`;
  const ring = keyringFrom(hex(), '');
  const before = await raw('GITHUB_TOKEN');
  const r1 = await reconcileOrgSecrets(db.sql, ring);
  assert.deepEqual(r1.encrypted, ['GITHUB_TOKEN', 'OPENAI_API_KEY']);
  const after = await raw('GITHUB_TOKEN');
  assert.ok(after!.value.startsWith('enc:v1:'));
  assert.equal(after!.updatedAt.toISOString(), before!.updatedAt.toISOString(), 'token age is not reset');
  assert.equal(await getOrgSecret(db.sql, 'OPENAI_API_KEY', ring), 'sk-old');
  const r2 = await reconcileOrgSecrets(db.sql, ring);
  assert.deepEqual(r2, { encrypted: [], reencrypted: [], plaintext: [], undecryptable: [] });
  assert.equal((await raw('GITHUB_TOKEN'))!.value, after!.value, 'second boot leaves the row byte-identical');
});

test('rotation: ASF_SECRET_KEY_PREVIOUS rows move to the new key', { skip }, async () => {
  await clear();
  const k1 = hex(); const k2 = hex();
  await putOrgSecret(db.sql, 'A', 'va', null, keyringFrom(k1, ''));
  await putOrgSecret(db.sql, 'B', 'vb', null, keyringFrom(k1, ''));
  const rotated = keyringFrom(k2, k1);
  assert.equal(await getOrgSecret(db.sql, 'A', rotated), 'va', 'readable mid-rotation');
  const r = await reconcileOrgSecrets(db.sql, rotated);
  assert.deepEqual(r.reencrypted, ['A', 'B']);
  const onlyNew = keyringFrom(k2, '');
  assert.equal(await getOrgSecret(db.sql, 'A', onlyNew), 'va');
  assert.equal(await getOrgSecret(db.sql, 'B', onlyNew), 'vb');
  assert.equal((await orgSecretStatus(db.sql, onlyNew)).state, 'encrypted');
});

test('wrong key: rows are left untouched, reads fail loudly, status is key-mismatch', { skip }, async () => {
  await clear();
  await putOrgSecret(db.sql, 'A', 'va', null, keyringFrom(hex(), ''));
  const stored = (await raw('A'))!.value;
  const wrong = keyringFrom(hex(), '');
  const r = await reconcileOrgSecrets(db.sql, wrong);
  assert.deepEqual(r.undecryptable, ['A']);
  assert.equal((await raw('A'))!.value, stored, 'never rewritten or deleted');
  await assert.rejects(getOrgSecret(db.sql, 'A', wrong), /encrypted with key/);
  const st = await orgSecretStatus(db.sql, wrong);
  assert.equal(st.state, 'key-mismatch'); assert.equal(st.undecryptable, 1);
  // saving the token again under the new key fixes it
  await putOrgSecret(db.sql, 'A', 'va2', null, wrong);
  assert.equal((await orgSecretStatus(db.sql, wrong)).state, 'encrypted');
});

test('an envelope copied onto another row (AAD) or tampered in the DB is rejected', { skip }, async () => {
  await clear();
  const ring = keyringFrom(hex(), '');
  await putOrgSecret(db.sql, 'GITHUB_TOKEN', 'gh', null, ring);
  await putOrgSecret(db.sql, 'GITLAB_TOKEN', 'gl', null, ring);
  await db.sql`UPDATE org_secret SET value = (SELECT value FROM org_secret WHERE name = 'GITHUB_TOKEN') WHERE name = 'GITLAB_TOKEN'`;
  await assert.rejects(getOrgSecret(db.sql, 'GITLAB_TOKEN', ring), /integrity check/);
  const v = (await raw('GITHUB_TOKEN'))!.value;
  await db.sql`UPDATE org_secret SET value = ${v.slice(0, -4) + (v.endsWith('AAAA') ? 'BBBB' : 'AAAA')} WHERE name = 'GITHUB_TOKEN'`;
  await assert.rejects(getOrgSecret(db.sql, 'GITHUB_TOKEN', ring), SecretKeyError);
  const st = await orgSecretStatus(db.sql, ring);
  assert.equal(st.undecryptable, 2);
  assert.equal((await reconcileOrgSecrets(db.sql, ring)).undecryptable.length, 2);
});
