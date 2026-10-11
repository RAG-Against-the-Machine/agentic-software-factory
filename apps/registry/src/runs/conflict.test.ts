import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, formatMergeConflict, MAX_CONFLICT_RESOLUTIONS, CONFLICT_QUEUED_BY } from '@asf/shared';
import { createRun, getRun, getEvents } from './store.js';
import { claimTask, finishTask, registerWorker } from './workers.js';
import { saveArtifact } from './gates-store.js';
import { resolveConflict, ConflictError } from './conflict.js';
import { advance } from './orchestrate.js';
import { dbAvailable, testDb, runInput, drain } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('conflict'); });
after(async () => { if (db) await db.close(); });

const CONFLICT = formatMergeConflict('main', ['apps/web/package.json', 'apps/web/src/api.ts']);

/** A merge-off run driven through all four roles to its push step, which is claimed and returned. */
async function atPush(wid: string, key: string) {
  await drain(db.sql);
  await registerWorker(db.sql, { id: wid, host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  const { run } = await createRun(db.sql, runInput({ ticketId: key.toLowerCase(), ticketKey: key, repoId: 'repo1', team: { ...STANDARD_TEAM, mergeEnabled: false } }));
  await finishRoles(wid, run.id);
  const push = await claimTask(db.sql, wid, ['claude-code']);
  assert.equal(String(push!.task.role), 'publish:push_open');
  return { runId: run.id, push: push! };
}
async function finishRoles(wid: string, runId: string, expect = ['planner', 'implementer', 'tester', 'reviewer']) {
  for (const role of expect) {
    const c = await claimTask(db.sql, wid, ['claude-code']);
    assert.equal(String(c!.task.role), role);
    if (role === 'reviewer') await saveArtifact(db.sql, runId, 'review.md', 'APPROVE');
    await finishTask(db.sql, c!.task.id, { outcome: 'done', outputRef: c!.task.outputRef, costUsd: 0.01, reason: null });
  }
}

test('a push that fails on a merge conflict hands it to the implementer, then re-tests, re-reviews and pushes again', { skip }, async () => {
  const { runId, push } = await atPush('c1', 'CF-1');
  await finishTask(db.sql, push.task.id, { outcome: 'failed', outputRef: null, costUsd: 0, reason: CONFLICT });

  const mid = (await getRun(db.sql, runId))!;
  assert.equal(mid.run.state, 'running', 'the run is NOT failed');
  const pending = mid.tasks.filter((t) => t.state === 'pending');
  assert.deepEqual(pending.map((t) => String(t.role)), ['implementer', 'tester', 'reviewer']);
  assert.ok(pending.every((t) => t.queuedBy === CONFLICT_QUEUED_BY));
  const impl = pending[0];
  assert.equal(impl.reason, 'conflict: apps/web/package.json, apps/web/src/api.ts');
  assert.equal(impl.queuedReason, 'resolve the merge conflict in apps/web/package.json, apps/web/src/api.ts');
  assert.equal(impl.attempt, 2);
  assert.equal(mid.tasks.find((t) => t.id === push.task.id)?.state, 'skipped', 'the failed push is superseded');
  const ev = (await getEvents(db.sql, runId, 0, 1000)).find((e) => e.kind === 'publish:conflict');
  assert.deepEqual(ev?.payload.files, ['apps/web/package.json', 'apps/web/src/api.ts']);

  // The team re-runs (no planner), then a FRESH push step is queued and succeeds.
  await finishRoles('c1', runId, ['implementer', 'tester', 'reviewer']);
  const push2 = await claimTask(db.sql, 'c1', ['claude-code']);
  assert.equal(String(push2!.task.role), 'publish:push_open');
  assert.notEqual(push2!.task.id, push.task.id);
  await finishTask(db.sql, push2!.task.id, { outcome: 'done', outputRef: null, costUsd: 0, reason: null });
  const ready = await claimTask(db.sql, 'c1', ['claude-code']);
  assert.equal(String(ready!.task.role), 'publish:mark_ready');
});

test(`after ${MAX_CONFLICT_RESOLUTIONS} automatic rounds the run fails, and a person can start another`, { skip }, async () => {
  const { runId, push } = await atPush('c2', 'CF-2');
  let p = push;
  for (let i = 0; i < MAX_CONFLICT_RESOLUTIONS; i++) {
    await finishTask(db.sql, p.task.id, { outcome: 'failed', outputRef: null, costUsd: 0, reason: CONFLICT });
    assert.equal((await getRun(db.sql, runId))!.run.state, 'running', `round ${i + 1} is automatic`);
    await finishRoles('c2', runId, ['implementer', 'tester', 'reviewer']);
    p = (await claimTask(db.sql, 'c2', ['claude-code']))!;
    assert.equal(String(p.task.role), 'publish:push_open');
  }
  await finishTask(db.sql, p.task.id, { outcome: 'failed', outputRef: null, costUsd: 0, reason: CONFLICT });
  const failed = (await getRun(db.sql, runId))!;
  assert.equal(failed.run.state, 'failed', 'bound reached: a person decides');
  assert.match(failed.run.reason ?? '', /^merge conflict with main/);
  const gaveUp = (await getEvents(db.sql, runId, 0, 1000)).filter((e) => e.kind === 'publish:conflict').at(-1);
  assert.equal(gaveUp?.payload.action, 'gave_up');

  // The run page's "Resolve the conflict": not bounded, the run lives again.
  await resolveConflict(db.sql, runId, 'jon');
  await advance(db.sql, runId);
  const again = (await getRun(db.sql, runId))!;
  assert.equal(again.run.state, 'running');
  assert.equal(again.run.finishedAt, null);
  assert.equal(String((await claimTask(db.sql, 'c2', ['claude-code']))!.task.role), 'implementer');
});

test('other failures still fail the run, and resolveConflict refuses runs that did not fail on a conflict', { skip }, async () => {
  const { runId, push } = await atPush('c3', 'CF-3');
  await finishTask(db.sql, push.task.id, { outcome: 'failed', outputRef: null, costUsd: 0, reason: 'nothing to publish: the branch has no changes over its base' });
  assert.equal((await getRun(db.sql, runId))!.run.state, 'failed');
  await assert.rejects(() => resolveConflict(db.sql, runId, 'jon'), (e: unknown) => e instanceof ConflictError && /did not fail on a merge conflict/.test((e as Error).message));

  const live = await atPush('c4', 'CF-4');
  await assert.rejects(() => resolveConflict(db.sql, live.runId, 'jon'), /only a run that failed on a merge conflict/);
});

test('a run that failed with the old conflict wording (before this change) can be resolved too', { skip }, async () => {
  const { runId, push } = await atPush('c5', 'CF-5');
  // Simulate the pre-change failure: the task fails before the orchestrator knew the new format.
  await db.sql`UPDATE run_task SET state = 'failed', reason = ${"cannot rebase onto main: git -c failed: Rebasing (1/3) — the ticket's changes conflict with work merged since the run started; re-dispatch to rebuild on current main"} WHERE id = ${push.task.id}`;
  await db.sql`UPDATE agent_run SET state = 'failed', finished_at = now() WHERE id = ${runId}`;
  await resolveConflict(db.sql, runId, 'jon');
  await advance(db.sql, runId);
  assert.equal(String((await claimTask(db.sql, 'c5', ['claude-code']))!.task.role), 'implementer');
});
