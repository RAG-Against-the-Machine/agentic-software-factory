import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunTask } from '@asf/shared';
import { groupStages, type Stage } from './stages';
import { stageLabel, taskStateLabel } from './words';

let seq = 0;
const task = (role: string, over: Partial<RunTask> = {}): RunTask => ({
  id: `t${++seq}`, runId: 'run_1', role, seq, state: 'done', attempt: 1, inputRef: null, outputRef: null,
  workerId: null, runtime: 'claude-code', model: null, effort: null, costUsd: 0, gateChecked: true,
  startedAt: '2026-09-01T00:00:00Z', finishedAt: null, reason: null, queuedBy: 'plan', queuedReason: null, ...over,
});
/** A copy that was queued and then superseded before it ever started. */
const placeholder = (role: string, over: Partial<RunTask> = {}) =>
  task(role, { state: 'skipped', startedAt: null, costUsd: 0, reason: 'superseded by gate rejection', ...over });
const line = (s: Stage) => [stageLabel(s.role), taskStateLabel(s.latest.state), s.note].filter(Boolean).join(' · ');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The #139 run: plan rejected twice with a note, then approved; the rest ran once. */
function fixture139(): RunTask[] {
  seq = 0;
  return [
    task('planner', { state: 'skipped', costUsd: 0.2 }),
    placeholder('implementer'), placeholder('tester'), placeholder('reviewer'),
    task('planner', { state: 'skipped', costUsd: 0.22, attempt: 2, queuedBy: 'gate_reject', queuedReason: 'split the migration out' }),
    placeholder('implementer', { attempt: 2, queuedBy: 'gate_reject' }), placeholder('tester', { attempt: 2, queuedBy: 'gate_reject' }), placeholder('reviewer', { attempt: 2, queuedBy: 'gate_reject' }),
    task('planner', { costUsd: 0.26, attempt: 3, queuedBy: 'gate_reject', queuedReason: 'keep the old endpoint' }),
    task('implementer', { costUsd: 1.1, attempt: 3, queuedBy: 'gate_reject' }),
    task('tester', { costUsd: 0.4, attempt: 3, queuedBy: 'gate_reject' }),
    task('reviewer', { costUsd: 0.3, attempt: 3, queuedBy: 'gate_reject' }),
    task('publish:push', { runtime: 'publish', startedAt: null }),
    task('publish:change_request', { runtime: 'publish', startedAt: null }),
  ];
}

test('#139: one row per stage, in team order', () => {
  const { roles, publish } = groupStages(fixture139());
  assert.deepEqual(roles.map((s) => s.role), ['planner', 'implementer', 'tester', 'reviewer']);
  assert.deepEqual(publish.map((s) => s.role), ['publish:push', 'publish:change_request']);
  assert.equal(line(roles[0]), 'Plan · Done · revised twice');
  assert.equal(round2(roles[0].totalCost), 0.68);
  assert.equal(line(roles[1]), 'Write code · Done');
});

test('#139: the plan stage lists its three tries with the feedback each got', () => {
  const plan = groupStages(fixture139()).roles[0];
  assert.deepEqual(plan.attempts.map((a) => [a.n, a.feedback, a.feedbackBy]), [
    [1, 'split the migration out', 'gate_reject'],
    [2, 'keep the old endpoint', 'gate_reject'],
    [3, 'approved', null],
  ]);
});

test('never-started placeholders are hidden; later stages show one try', () => {
  const { roles } = groupStages(fixture139());
  for (const s of roles.slice(1)) assert.equal(s.attempts.length, 1);
});

test('stage costs add up to the job total', () => {
  const tasks = fixture139();
  const { roles, publish } = groupStages(tasks);
  const sum = [...roles, ...publish].reduce((s, st) => s + st.totalCost, 0);
  assert.equal(round2(sum), round2(tasks.reduce((s, t) => s + t.costUsd, 0)));
});

test('a stage re-queued by a rejection reads "re-running after your feedback"', () => {
  seq = 0;
  const { roles } = groupStages([
    task('planner', { state: 'skipped', costUsd: 0.2 }),
    placeholder('implementer'),
    task('planner', { state: 'running', attempt: 2, queuedBy: 'gate_reject', queuedReason: 'smaller' }),
    task('implementer', { state: 'pending', startedAt: null, attempt: 2, queuedBy: 'gate_reject' }),
  ]);
  assert.equal(roles[0].note, 're-running after your feedback');
  assert.equal(roles[1].note, null, 'a stage that never ran is not "re-running"');
  assert.equal(roles[1].attempts.length, 0);
});

test('a review loop reads "round N after review"; the reviewer verdict is the feedback', () => {
  seq = 0;
  const { roles } = groupStages([
    task('implementer', { state: 'skipped', costUsd: 1 }),
    task('reviewer', { state: 'skipped', costUsd: 0.3 }),
    task('implementer', { state: 'running', attempt: 2, queuedBy: 'loop_back', queuedReason: 'REQUEST_CHANGES: add a test' }),
    task('reviewer', { state: 'pending', startedAt: null, attempt: 2, queuedBy: 'loop_back' }),
  ]);
  assert.equal(roles[0].note, 'round 2 after review');
  assert.equal(roles[1].note, 'round 2 after review');
  assert.deepEqual([roles[0].attempts[0].feedback, roles[0].attempts[0].feedbackBy], ['REQUEST_CHANGES: add a test', 'loop_back']);
});

test('a retried stage reads "retrying"; a failed latest attempt drives the status', () => {
  seq = 0;
  const failed = groupStages([task('planner'), task('implementer', { state: 'failed', costUsd: 0.5 })]).roles[1];
  assert.equal(failed.latest.state, 'failed');
  assert.equal(line(failed), 'Write code · Failed');
  assert.equal(failed.attempts[0].feedback, null);

  seq = 0;
  const retrying = groupStages([
    task('implementer', { state: 'skipped', costUsd: 0.5 }),
    task('implementer', { state: 'running', attempt: 2, queuedBy: 'retry' }),
  ]).roles[0];
  assert.equal(retrying.note, 'retrying');
});
