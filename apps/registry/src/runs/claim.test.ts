import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, getRun, resumeRun } from './store.js';
import { claimTask, finishTask, registerWorker, deregisterWorker } from './workers.js';
import { sweep } from './sweeper.js';
import { dbAvailable, testDb, runInput } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('claim'); });
after(async () => { if (db) await db.close(); });

test('two concurrent claims on one pending task: exactly one wins', { skip }, async () => {
  await createRun(db.sql, runInput({ ticketId: 'k1', ticketKey: 'K-1' }));
  for (const id of ['a', 'b']) await registerWorker(db.sql, { id, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const [x, y] = await Promise.all([claimTask(db.sql, 'a', ['claude-code']), claimTask(db.sql, 'b', ['claude-code'])]);
  assert.equal([x, y].filter(Boolean).length, 1, 'only the first task (planner) is claimable; the implementer waits on it');
});

test('a task is not claimable while its predecessor is running; runtime filter honoured', { skip }, async () => {
  const { run } = await createRun(db.sql, runInput({ ticketId: 'k2', ticketKey: 'K-2' }));
  await registerWorker(db.sql, { id: 'c', host: 'h', runtimes: ['claude-code'], maxConcurrent: 2, inFlightTaskIds: [] });
  const first = await claimTask(db.sql, 'c', ['claude-code']);
  assert.equal(first?.run.id, run.id);
  assert.equal(await claimTask(db.sql, 'c', ['claude-code']), null, 'implementer must wait for the planner');
  await finishTask(db.sql, first!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0.1, reason: null });
  assert.equal(await claimTask(db.sql, 'c', ['codex']), null, 'a worker without the runtime cannot take it');
  const second = await claimTask(db.sql, 'c', ['claude-code']);
  assert.equal(second?.task.role, 'implementer');
});

test('re-registering with an empty in-flight list stales the run it held; resume re-queues it', { skip }, async () => {
  const { run } = await createRun(db.sql, runInput({ ticketId: 'k3', ticketKey: 'K-3' }));
  await registerWorker(db.sql, { id: 'd', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const claim = await claimTask(db.sql, 'd', ['claude-code']);
  assert.equal(claim?.run.id, run.id);
  const { staled } = await registerWorker(db.sql, { id: 'd', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  assert.deepEqual(staled, [run.id]);
  assert.equal((await getRun(db.sql, run.id))!.run.state, 'stale');
  await resumeRun(db.sql, run.id, 'test');
  const again = await claimTask(db.sql, 'd', ['claude-code']);
  assert.equal(again?.task.role, 'planner');
  assert.equal(again?.task.attempt, 2);
});

test('deregister stales held runs; sweeper stales silent runs and forgets dead workers', { skip }, async () => {
  const { run } = await createRun(db.sql, runInput({ ticketId: 'k4', ticketKey: 'K-4' }));
  await registerWorker(db.sql, { id: 'e', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  await claimTask(db.sql, 'e', ['claude-code']);
  const { staled } = await deregisterWorker(db.sql, 'e');
  assert.deepEqual(staled, [run.id]);

  const { run: r2 } = await createRun(db.sql, runInput({ ticketId: 'k5', ticketKey: 'K-5' }));
  await registerWorker(db.sql, { id: 'f', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  await claimTask(db.sql, 'f', ['claude-code']);
  const before = await sweep(db.sql, new Date());
  assert.ok(!before.staleRuns.includes(r2.id), 'not stale yet');
  const later = new Date(Date.now() + 20 * 60_000);
  const result = await sweep(db.sql, later);
  assert.ok(result.staleRuns.includes(r2.id));
  assert.ok(result.deadWorkers.includes('f'));
  assert.equal((await getRun(db.sql, r2.id))!.run.state, 'stale');
});
