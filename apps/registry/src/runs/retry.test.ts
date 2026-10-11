import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, getRun } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { retryFailedTask } from './gates.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('retry'); });
after(async () => { if (db) await db.close(); });

test('retry flips a failed run back to running with a fresh pending task', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'rt1', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'r-retry', ticketKey: 'R-1', repoId: null }));

  // The first role runs and fails; the run fails.
  const planner = await claimTask(db.sql, 'rt1', ['claude-code']);
  await finishTask(db.sql, planner!.task.id, { outcome: 'failed', outputRef: null, costUsd: 0.2, reason: 'boom' });
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'failed');

  await retryFailedTask(db.sql, run.id, 'try again please', 'jon');

  const after = await getRun(db.sql, run.id);
  assert.equal(after!.run.state, 'running', 'run is live again');
  assert.equal(after!.run.finishedAt, null, 'the terminal finish stamp is cleared');
  const planners = after!.tasks.filter((t) => String(t.role) === 'planner');
  assert.ok(planners.some((t) => t.state === 'skipped' && t.id === planner!.task.id), 'the failed task is skipped');
  const fresh = planners.find((t) => t.state === 'pending');
  assert.ok(fresh, 'a fresh pending planner exists');
  assert.equal(fresh!.attempt, 2);
  assert.equal(fresh!.queuedBy, 'retry');
  assert.equal(fresh!.reason, 'retry: try again please');

  // The re-queued role is claimable again.
  const again = await claimTask(db.sql, 'rt1', ['claude-code']);
  assert.equal(again?.task.role, 'planner');
  assert.equal(again?.task.attempt, 2);
});

test('retry errors when the run has no failed role task', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 'r-nofail', ticketKey: 'R-2', repoId: null }));
  await assert.rejects(() => retryFailedTask(db.sql, run.id, null, null), /no failed role task/);
});
