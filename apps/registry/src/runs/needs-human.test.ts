import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, getRun } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { getArtifact } from './gates-store.js';
import { answerNeedsHuman, skipNeedsHuman, NeedsHumanError } from './needs-human.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('needshuman'); });
after(async () => { if (db) await db.close(); });

/** Drive a fresh run until its planner parks at needs_human. */
async function parkAtNeedsHuman(workerId: string, ticketId: string, ticketKey: string) {
  const { run } = await createRun(db.sql, runInput({ ticketId, ticketKey, repoId: null }));
  await registerWorker(db.sql, { id: workerId, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const planner = await claimTask(db.sql, workerId, ['claude-code']);
  assert.equal(planner?.task.role, 'planner');
  await finishTask(db.sql, planner!.task.id, { outcome: 'needs_human', outputRef: null, costUsd: 0, reason: 'which auth strategy?' });
  const parked = await getRun(db.sql, run.id);
  assert.equal(parked!.run.state, 'awaiting_checkpoint');
  return run.id;
}

test('answering saves the reply as human-reply.md and re-queues the same role', { skip }, async () => {
  await drain(db.sql);
  const runId = await parkAtNeedsHuman('nh1', 'nh-a', 'NH-A');

  await answerNeedsHuman(db.sql, runId, 'Use OAuth device flow.', 'jon');

  // The reply is persisted as an artifact the worker will surface as {{prior.humanReply}}.
  assert.equal(await getArtifact(db.sql, runId, 'human-reply.md'), 'Use OAuth device flow.');

  // The run is running again and the planner is claimable as a fresh attempt.
  const after = await getRun(db.sql, runId);
  assert.equal(after!.run.state, 'running');
  const rerun = await claimTask(db.sql, 'nh1', ['claude-code']);
  assert.equal(rerun?.task.role, 'planner');
  assert.equal(rerun?.task.attempt, 2, 'planner re-runs as attempt 2');
  assert.match(rerun?.task.reason ?? '', /human answer: Use OAuth/);
});

test('skipping marks the role skipped and lets the run move on', { skip }, async () => {
  await drain(db.sql);
  const runId = await parkAtNeedsHuman('nh2', 'nh-b', 'NH-B');

  await skipNeedsHuman(db.sql, runId, 'jon');

  const after = await getRun(db.sql, runId);
  const planner = after!.tasks.find((t) => String(t.role) === 'planner');
  assert.equal(planner!.state, 'skipped');
  assert.equal(after!.run.state, 'running');
  // The next role (implementer) is now claimable since the planner is skipped.
  const next = await claimTask(db.sql, 'nh2', ['claude-code']);
  assert.equal(next?.task.role, 'implementer');
});

test('answering a run with nothing parked is a NeedsHumanError', { skip }, async () => {
  await drain(db.sql);
  const { run } = await createRun(db.sql, runInput({ ticketId: 'nh-c', ticketKey: 'NH-C', repoId: null }));
  await assert.rejects(() => answerNeedsHuman(db.sql, run.id, 'hi', 'jon'), (e: unknown) => e instanceof NeedsHumanError);
});
