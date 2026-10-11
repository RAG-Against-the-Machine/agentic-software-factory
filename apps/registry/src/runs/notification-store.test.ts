import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GATES } from '@asf/shared';
import { createRun } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { saveArtifact, getOpenGate } from './gates-store.js';
import { listNotifications, markNotificationRead, undeliveredNotifications, markNotificationDelivered, clearNotifications } from './notification-store.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('notif'); });
after(async () => { if (db) await db.close(); });

/** All notifications for a run, since listNotifications is global. */
async function forRun(runId: string) {
  const { notifications } = await listNotifications(db.sql, { limit: 200 });
  return notifications.filter((n) => n.runId === runId);
}

test('the orchestrator records a gate notification with a Review action when a required gate opens', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'n1', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'n-gate', ticketKey: 'N-1', gates: DEFAULT_GATES, repoId: null }));
  const planner = await claimTask(db.sql, 'n1', ['claude-code']);
  await saveArtifact(db.sql, run.id, 'plan.md', 'PLAN');
  await finishTask(db.sql, planner!.task.id, { outcome: 'done', outputRef: 'plan.md', costUsd: 0, reason: null });

  const gate = await getOpenGate(db.sql, run.id);
  assert.ok(gate, 'gate should be open');
  const notes = await forRun(run.id);
  const gateNote = notes.find((n) => n.kind === 'gate');
  assert.ok(gateNote, 'a gate notification should be recorded');
  assert.equal(gateNote!.gateId, gate!.id);
  assert.match(gateNote!.title, /N-1/);
  assert.match(gateNote!.title, /after plan/);
  assert.deepEqual(gateNote!.actions, [{ label: 'Review', url: `/run/${run.id}` }]);
});

test('the orchestrator records a needs_human notification when a task parks', { skip }, async () => {
  await drain(db.sql);
  await registerWorker(db.sql, { id: 'n2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: 'n-nh', ticketKey: 'N-2', repoId: null }));
  const planner = await claimTask(db.sql, 'n2', ['claude-code']);
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'which database?' });
  const notes = await forRun(run.id);
  const nh = notes.find((n) => n.kind === 'needs_human');
  assert.ok(nh, 'a needs_human notification should be recorded');
  assert.match(nh!.body, /which database/);
});

test('listNotifications counts unread; markRead clears it; mark-all works', { skip }, async () => {
  await drain(db.sql);
  await db.sql`DELETE FROM notification`;
  const { run } = await createRun(db.sql, runInput({ ticketId: 'n-read', ticketKey: 'N-3', repoId: null }));
  await registerWorker(db.sql, { id: 'n3', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const planner = await claimTask(db.sql, 'n3', ['claude-code']);
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'q' });

  const before = await listNotifications(db.sql, { limit: 50 });
  assert.ok(before.unread >= 1);
  const one = before.notifications.find((n) => n.runId === run.id)!;
  await markNotificationRead(db.sql, one.id);
  const after = await listNotifications(db.sql, { limit: 50 });
  assert.equal(after.unread, 0, 'only notification marked read');

  // unreadOnly filter
  const onlyUnread = await listNotifications(db.sql, { unreadOnly: true, limit: 50 });
  assert.equal(onlyUnread.notifications.length, 0);
});

test('delivery cursor: undelivered lists new rows, markDelivered removes them from the cursor', { skip }, async () => {
  await drain(db.sql);
  await db.sql`DELETE FROM notification`;
  const { run } = await createRun(db.sql, runInput({ ticketId: 'n-deliv', ticketKey: 'N-4', repoId: null }));
  await registerWorker(db.sql, { id: 'n4', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const planner = await claimTask(db.sql, 'n4', ['claude-code']);
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'q' });

  const before = await undeliveredNotifications(db.sql, 50);
  const mine = before.find((n) => n.runId === run.id);
  assert.ok(mine, 'row should be undelivered initially');
  await markNotificationDelivered(db.sql, mine!.id);
  const after = await undeliveredNotifications(db.sql, 50);
  assert.ok(!after.some((n) => n.id === mine!.id), 'delivered row leaves the cursor');
});

test('clearNotifications deletes every row and zeroes the unread count', { skip }, async () => {
  await drain(db.sql);
  await db.sql`DELETE FROM notification`;
  await createRun(db.sql, runInput({ ticketId: 'n-clr', ticketKey: 'N-5', repoId: null }));
  await registerWorker(db.sql, { id: 'n5', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const planner = await claimTask(db.sql, 'n5', ['claude-code']);
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'q' });
  assert.ok((await listNotifications(db.sql, { limit: 50 })).notifications.length >= 1, 'has notifications before clear');

  await clearNotifications(db.sql);
  const { notifications, unread } = await listNotifications(db.sql, { limit: 50 });
  assert.equal(notifications.length, 0, 'all rows deleted');
  assert.equal(unread, 0, 'unread count is zero after clear');
});
