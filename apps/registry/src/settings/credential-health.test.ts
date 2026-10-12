import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { recordCredentialHealth, resetCredentialHealth, listCredentialHealth } from './credential-health.js';
import { putOrgSecret, listOrgSecrets } from './secret-store.js';
import { listNotifications } from '../runs/notification-store.js';
import { dbAvailable, testDb } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('credhealth'); });
after(async () => { if (db) await db.close(); });

const fail = (key: string) => ({ key, ok: false, reason: 'HTTP 401 Bad credentials', label: 'GitHub token', link: '/settings#tickets' });
const pass = (key: string) => ({ key, ok: true, reason: null, label: 'GitHub token', link: '/settings#tickets' });
const credentialNotes = async () => (await listNotifications(db.sql, { limit: 200 })).notifications.filter((n) => n.kind === 'credential');

test('upserts health: a failure keeps its first failing_since; recovery clears it', { skip }, async () => {
  const first = await recordCredentialHealth(db.sql, fail('JIRA_API_TOKEN'));
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'HTTP 401 Bad credentials');
  assert.ok(first.failingSince);

  const again = await recordCredentialHealth(db.sql, { ...fail('JIRA_API_TOKEN'), reason: 'HTTP 403' });
  assert.equal(again.failingSince, first.failingSince, 'failing_since is the start of the failure, not the latest check');
  assert.equal(again.reason, 'HTTP 403');

  const ok = await recordCredentialHealth(db.sql, pass('JIRA_API_TOKEN'));
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.failingSince, null);
  assert.equal(ok.alertedAt, null);
  assert.deepEqual((await listCredentialHealth(db.sql)).map((h) => h.key), ['JIRA_API_TOKEN']);
});

test('one alert per failure, with no run; recovery or a re-save re-arms it', { skip }, async () => {
  await db.sql`DELETE FROM notification`;
  await recordCredentialHealth(db.sql, fail('GITHUB_TOKEN'));
  await recordCredentialHealth(db.sql, fail('GITHUB_TOKEN'));
  await Promise.all([recordCredentialHealth(db.sql, fail('GITHUB_TOKEN')), recordCredentialHealth(db.sql, fail('GITHUB_TOKEN'))]);
  let notes = await credentialNotes();
  assert.equal(notes.length, 1, 'repeated failed checks alert once');
  assert.equal(notes[0].runId, null);
  assert.match(notes[0].title, /GitHub token stopped working/);
  assert.match(notes[0].body, /401/);
  assert.deepEqual(notes[0].actions, [{ label: 'Fix in Settings', url: '/settings#tickets' }]);

  // recovery, then a new failure: a second alert
  await recordCredentialHealth(db.sql, pass('GITHUB_TOKEN'));
  await recordCredentialHealth(db.sql, fail('GITHUB_TOKEN'));
  notes = await credentialNotes();
  assert.equal(notes.length, 2);

  // a re-save resets it, so the next failure alerts again
  await resetCredentialHealth(db.sql, 'GITHUB_TOKEN');
  assert.deepEqual((await listCredentialHealth(db.sql)).filter((h) => h.key === 'GITHUB_TOKEN'), []);
  await recordCredentialHealth(db.sql, fail('GITHUB_TOKEN'));
  assert.equal((await credentialNotes()).length, 3);
});

const FIX = 'On the computer running worker w1, run: gcloud auth application-default login. The worker picks the new login up by itself within a few minutes; no restart needed.';
const loginFail = (key: string, reason: string | null = 'Google login on worker w1 stopped working (expired or revoked).') =>
  ({ key, ok: false, reason, label: 'Google login on worker w1', link: '/workers', fix: FIX });
const clearNotes = () => db.sql`TRUNCATE notification`;

test('with a fix: the body is reason + fix once, and the action is “See what’s wrong”', { skip }, async () => {
  await clearNotes();
  const reason = 'Claude on Google Cloud stopped working on worker w1: Google says the login has expired or was revoked.';
  await recordCredentialHealth(db.sql, loginFail('google-login:w1', reason));
  const notes = await credentialNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].runId, null);
  assert.match(notes[0].title, /Your Google login on worker w1 stopped working/);
  assert.equal(notes[0].body, `${reason} ${FIX}`);
  assert.equal(notes[0].body.split('gcloud auth application-default login').length - 1, 1, 'the fix appears once');
  assert.doesNotMatch(notes[0].body, /save a new one in Settings/, 'the generic Settings advice is replaced');
  assert.deepEqual(notes[0].actions, [{ label: 'See what’s wrong', url: '/workers' }]);
});

test('with a fix and a null reason: the default lead-in, then the fix', { skip }, async () => {
  await clearNotes();
  await recordCredentialHealth(db.sql, loginFail('google-login:w3', null));
  const [n] = await credentialNotes();
  assert.equal(n.body, `The connection test failed. ${FIX}`);
});

test('with a fix: a repeat failure of the same streak sends no second notification; recovery re-arms it', { skip }, async () => {
  await clearNotes();
  await recordCredentialHealth(db.sql, loginFail('google-login:w4'));
  await recordCredentialHealth(db.sql, loginFail('google-login:w4'));
  await Promise.all([recordCredentialHealth(db.sql, loginFail('google-login:w4')), recordCredentialHealth(db.sql, loginFail('google-login:w4'))]);
  assert.equal((await credentialNotes()).length, 1, 'one alert per failure streak');

  await recordCredentialHealth(db.sql, { key: 'google-login:w4', ok: true, reason: null, label: 'Google login on worker w1', link: '/workers' });
  await recordCredentialHealth(db.sql, loginFail('google-login:w4'));
  assert.equal((await credentialNotes()).length, 2, 'a new expiry after recovery alerts again');
});

test('without a fix the legacy wording and "Fix in Settings" action are unchanged', { skip }, async () => {
  await clearNotes();
  await recordCredentialHealth(db.sql, fail('LEGACY_TOKEN'));
  const [n] = await credentialNotes();
  assert.equal(n.body, 'HTTP 401 Bad credentials Runs that need it will fail until you save a new one in Settings.');
  assert.deepEqual(n.actions, [{ label: 'Fix in Settings', url: '/settings#tickets' }]);
});

test('listOrgSecrets returns each secret with its updatedAt', { skip }, async () => {
  await putOrgSecret(db.sql, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-x', 'jon');
  const [s] = (await listOrgSecrets(db.sql)).filter((x) => x.name === 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.ok(s);
  assert.ok(Math.abs(Date.parse(s.updatedAt) - Date.now()) < 60_000);
});
