import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, listQueue, reorderQueue, removeQueueEntry, readyQueueEntries, markQueueEntry } from './queue-store.js';
import { createRun } from './store.js';
import { dbAvailable, testDb, runInput } from '../test/harness.js';
import type { EnqueueItem } from '@asf/shared';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('queue'); });
after(async () => { if (db) await db.close(); });

const item = (n: string): EnqueueItem => ({ ticketId: n, ticketKey: n.toUpperCase(), ticketProvider: 'mock', repoId: null, teamName: null, maxCostUsd: null });

test('enqueue appends a batch at the tail in order; dedupes an already-queued ticket', { skip }, async () => {
  const first = await enqueue(db.sql, [item('q1'), item('q2')], 'parallel', 'jon');
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((e) => e.ticketId), ['q1', 'q2']);
  assert.ok(first[0].position < first[1].position, 'positions ascend');
  // q1 is already queued -> skipped; q3 is new -> added.
  const second = await enqueue(db.sql, [item('q1'), item('q3')], 'parallel', 'jon');
  assert.deepEqual(second.map((e) => e.ticketId), ['q3']);
  const all = await listQueue(db.sql, { limit: 100 });
  assert.deepEqual(all.filter((e) => e.state === 'queued').map((e) => e.ticketId), ['q1', 'q2', 'q3']);
});

test('reorder moves an entry before another; remove cancels it', { skip }, async () => {
  const [a, _b, c] = await enqueue(db.sql, [item('r1'), item('r2'), item('r3')], 'parallel', 'jon');
  // Move r3 before r1 -> order r3, r1, r2.
  await reorderQueue(db.sql, c.id, a.id);
  let order = (await listQueue(db.sql, { state: 'queued', limit: 100 })).filter((e) => e.ticketId.startsWith('r')).map((e) => e.ticketId);
  assert.deepEqual(order, ['r3', 'r1', 'r2']);
  // Remove r1.
  await removeQueueEntry(db.sql, a.id, 'jon');
  order = (await listQueue(db.sql, { state: 'queued', limit: 100 })).filter((e) => e.ticketId.startsWith('r')).map((e) => e.ticketId);
  assert.deepEqual(order, ['r3', 'r2']);
  const removed = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === a.id)!;
  assert.equal(removed.state, 'cancelled');
  assert.match(removed.reason ?? '', /removed by jon/);
});

test('parallel entries are all ready at once', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`; // clear the queue
  await enqueue(db.sql, [item('p1'), item('p2'), item('p3')], 'parallel', 'jon');
  const ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId).sort(), ['p1', 'p2', 'p3']);
});

test('serial: only the head is ready; the next releases when the prior run reaches a gate', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [s1, s2, s3] = await enqueue(db.sql, [item('s1'), item('s2'), item('s3')], 'serial', 'jon');

  // Only the batch head is ready initially.
  let ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId), ['s1']);

  // Dispatch s1 -> a real run in 'queued' (not yet claimed). s2 must still be blocked.
  const run1 = await createRun(db.sql, runInput({ ticketId: 's1-run', ticketKey: 'S1' }));
  await markQueueEntry(db.sql, s1.id, 'dispatched', run1.run.id, null);
  ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId), [], 's2 blocked while s1 run is queued/running');

  // s1 run reaches its first gate (awaiting_checkpoint) -> s2 releases.
  await db.sql`UPDATE agent_run SET state = 'awaiting_checkpoint' WHERE id = ${run1.run.id}`;
  ready = await readyQueueEntries(db.sql, 20);
  assert.deepEqual(ready.map((e) => e.ticketId), ['s2'], 's2 ready once s1 is at a gate');

  // Dispatch s2, then let its run finish terminally -> s3 releases.
  const run2 = await createRun(db.sql, runInput({ ticketId: 's2-run', ticketKey: 'S2' }));
  await markQueueEntry(db.sql, s2.id, 'dispatched', run2.run.id, null);
  assert.deepEqual((await readyQueueEntries(db.sql, 20)).map((e) => e.ticketId), []);
  await db.sql`UPDATE agent_run SET state = 'succeeded', finished_at = now() WHERE id = ${run2.run.id}`;
  assert.deepEqual((await readyQueueEntries(db.sql, 20)).map((e) => e.ticketId), ['s3']);
  void s3;
});

test('markQueueEntry failed records the reason and drops it from ready', { skip }, async () => {
  await db.sql`UPDATE work_queue SET state = 'cancelled'`;
  const [f1] = await enqueue(db.sql, [item('f1')], 'parallel', 'jon');
  await markQueueEntry(db.sql, f1.id, 'failed', null, 'no repo bound');
  const row = (await listQueue(db.sql, { limit: 100 })).find((e) => e.id === f1.id)!;
  assert.equal(row.state, 'failed');
  assert.equal(row.reason, 'no repo bound');
  assert.deepEqual((await readyQueueEntries(db.sql, 20)).map((e) => e.ticketId), []);
});
