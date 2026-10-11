import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { putOrgSecret, deleteOrgSecret, getOrgSecret, listOrgSecretNames } from './secret-store.js';
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
