import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun } from './store.js';
import { saveArtifact, getArtifact, listArtifacts, listArtifactVersions } from './gates-store.js';
import { testDb, dbAvailable, runInput } from '../test/harness.js';

// M11 WP1: run_artifact keeps one version PER PRODUCING TASK, not one per name.
// A review loop (three reviewer tasks) must leave three review.md rows; the gate
// check / publish / UI list still read the newest via getArtifact/listArtifacts.
const ok = await dbAvailable();
let db: Awaited<ReturnType<typeof testDb>>;
before(async () => { if (ok) db = await testDb('artifacts'); });
after(async () => { if (ok && db) await db.close(); });

test('a different task adds a version; the same task upserts; latest wins for readers', { skip: !ok }, async () => {
  const { run, tasks } = await createRun(db.sql, runInput({ ticketId: 'art-1', ticketKey: 'ART-1' }));
  const reviewer = tasks.find((t) => String(t.role) === 'reviewer')!;
  const impl = tasks.find((t) => String(t.role) === 'implementer')!;

  // reviewer writes review.md, then re-writes it in the SAME task -> one version, latest content.
  await saveArtifact(db.sql, run.id, 'review.md', 'REQUEST_CHANGES v1', { taskId: reviewer.id });
  await saveArtifact(db.sql, run.id, 'review.md', 'REQUEST_CHANGES v1b', { taskId: reviewer.id });
  let versions = (await listArtifactVersions(db.sql, run.id)).filter((v) => v.name === 'review.md');
  assert.equal(versions.length, 1, 'same task upserts');
  assert.equal(versions[0].content, 'REQUEST_CHANGES v1b');
  assert.equal(await getArtifact(db.sql, run.id, 'review.md'), 'REQUEST_CHANGES v1b');

  // a DIFFERENT task (next loop iteration) writing the same name -> a new version.
  await saveArtifact(db.sql, run.id, 'review.md', 'APPROVE v2', { taskId: impl.id });
  versions = (await listArtifactVersions(db.sql, run.id)).filter((v) => v.name === 'review.md');
  assert.equal(versions.length, 2, 'different task adds a version');
  assert.equal(await getArtifact(db.sql, run.id, 'review.md'), 'APPROVE v2', 'latest wins for the gate/publish reader');

  // listArtifacts (the flat UI list) returns exactly one row per name = the newest.
  const flat = (await listArtifacts(db.sql, run.id)).filter((a) => a.name === 'review.md');
  assert.equal(flat.length, 1);
  assert.equal(flat[0].content, 'APPROVE v2');
});

test('a task-less write (legacy / human gate edit) collapses to one slot per name', { skip: !ok }, async () => {
  const { run } = await createRun(db.sql, runInput({ ticketId: 'art-2', ticketKey: 'ART-2' }));
  await saveArtifact(db.sql, run.id, 'plan.md', 'plan A', { source: 'human' });
  await saveArtifact(db.sql, run.id, 'plan.md', 'plan B (edited again)', { source: 'human' });
  const versions = (await listArtifactVersions(db.sql, run.id)).filter((v) => v.name === 'plan.md');
  assert.equal(versions.length, 1, 'NULL task_id upserts into one slot');
  assert.equal(versions[0].source, 'human');
  assert.equal(await getArtifact(db.sql, run.id, 'plan.md'), 'plan B (edited again)');
});

test('attempt is copied from the producing task so the UI can label the iteration', { skip: !ok }, async () => {
  const { run, tasks } = await createRun(db.sql, runInput({ ticketId: 'art-3', ticketKey: 'ART-3' }));
  const reviewer = tasks.find((t) => String(t.role) === 'reviewer')!;
  await db.sql`UPDATE run_task SET attempt = 3 WHERE id = ${reviewer.id}`;
  await saveArtifact(db.sql, run.id, 'review.md', 'third pass', { taskId: reviewer.id });
  const v = (await listArtifactVersions(db.sql, run.id)).find((x) => x.name === 'review.md')!;
  assert.equal(v.attempt, 3);
  assert.equal(v.taskId, reviewer.id);
});
