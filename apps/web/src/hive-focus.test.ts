import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiveFocus, memberStates, pictureState, HANDOFF_MS, type FocusTask } from './hive-focus';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const t = (role: string, state: string, seq: number, startedMsAgo: number | null = 60_000): FocusTask =>
  ({ role, state, seq, startedAt: startedMsAgo == null ? null : ago(startedMsAgo) });

const done4 = [t('planner', 'done', 0), t('implementer', 'done', 1), t('tester', 'done', 2), t('reviewer', 'done', 3)];

const rows: Array<[string, Parameters<typeof hiveFocus>[0], string, string, string | null]> = [
  ['succeeded', { run: { state: 'succeeded' }, tasks: done4 }, 'orchestrator', 'delivered', null],
  ['failed', { run: { state: 'failed' }, tasks: [t('implementer', 'failed', 1)] }, 'orchestrator', 'failed', null],
  ['halted', { run: { state: 'halted' }, tasks: [] }, 'orchestrator', 'failed', null],
  ['cancelled', { run: { state: 'cancelled' }, tasks: [] }, 'orchestrator', 'failed', null],
  ['stale', { run: { state: 'stale' }, tasks: [] }, 'orchestrator', 'failed', null],
  ['open gate', { run: { state: 'awaiting_checkpoint' }, tasks: [t('planner', 'done', 0)], gates: [{ state: 'open' }] }, 'orchestrator', 'gate', null],
  ['needs_human', { run: { state: 'awaiting_checkpoint' }, tasks: [t('planner', 'needs_human', 0)] }, 'planner', 'question', 'planner'],
  ['publish running', { run: { state: 'running' }, tasks: [...done4, t('publish:push', 'running', 4)] }, 'orchestrator', 'delivering', null],
  ['conflict', { run: { state: 'running' }, tasks: done4, events: [{ kind: 'task:finished' }, { kind: 'publish:conflict' }] }, 'orchestrator', 'conflict', null],
  ['handoff', { run: { state: 'running' }, tasks: [t('planner', 'done', 0), t('implementer', 'running', 1, 1500)] }, 'implementer', 'handoff', 'implementer'],
  ['working', { run: { state: 'running' }, tasks: [t('planner', 'done', 0), t('implementer', 'running', 1, 30_000)] }, 'implementer', 'working', 'implementer'],
  ['queued', { run: { state: 'queued' }, tasks: [t('planner', 'pending', 0, null)] }, 'orchestrator', 'idle', null],
  ['between tasks', { run: { state: 'running' }, tasks: [t('planner', 'done', 0), t('implementer', 'pending', 1, null)] }, 'orchestrator', 'idle', null],
];

for (const [name, input, focus, mood, member] of rows) {
  test(`hive focus: ${name} → ${focus} / ${mood}`, () => {
    assert.deepEqual(hiveFocus({ ...input, now: NOW }), { focus, mood, member });
  });
}

test('precedence: a gate beats a running task; a question beats working; conflict beats working', () => {
  const running = [t('implementer', 'running', 1)];
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks: running, gates: [{ state: 'open' }], now: NOW }).mood, 'gate');
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks: [...running, t('tester', 'needs_human', 2)], now: NOW }).mood, 'question');
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks: running, events: [{ kind: 'conflict:merging' }], now: NOW }).mood, 'conflict');
  // terminal states beat everything
  assert.equal(hiveFocus({ run: { state: 'succeeded' }, tasks: running, gates: [{ state: 'open' }], now: NOW }).mood, 'delivered');
});

test('a resolved conflict no longer holds the spotlight; a later one does', () => {
  const tasks = [t('implementer', 'running', 5)];
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks, events: [{ kind: 'publish:conflict' }, { kind: 'conflict:resolved' }], now: NOW }).mood, 'working');
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks, events: [{ kind: 'publish:conflict' }, { kind: 'conflict:resolved' }, { kind: 'conflict:merging' }], now: NOW }).mood, 'conflict');
});

test('a closed gate is ignored', () => {
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks: [t('tester', 'running', 2)], gates: [{ state: 'approved' }], now: NOW }).focus, 'tester');
});

test('handoff lasts HANDOFF_MS, and a clock skew (start in the future) reads as working', () => {
  const at = (ms: number) => hiveFocus({ run: { state: 'running' }, tasks: [t('reviewer', 'running', 3, ms)], now: NOW }).mood;
  assert.equal(at(0), 'handoff');
  assert.equal(at(HANDOFF_MS - 1), 'handoff');
  assert.equal(at(HANDOFF_MS), 'working');
  assert.equal(at(-5000), 'working');
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks: [t('reviewer', 'running', 3, null)], now: NOW }).mood, 'working');
});

test('a loop-back: the latest try of a role is the one that counts', () => {
  const tasks = [t('planner', 'done', 0), t('implementer', 'done', 1), t('reviewer', 'done', 3), t('implementer', 'running', 4, 20_000)];
  assert.equal(hiveFocus({ run: { state: 'running' }, tasks, now: NOW }).focus, 'implementer');
  assert.deepEqual(memberStates([...tasks].reverse()), { planner: 'done', implementer: 'running', reviewer: 'done' });
});

test('member states ignore publish steps', () => {
  assert.deepEqual(memberStates([...done4, t('publish:push', 'running', 4)]), { planner: 'done', implementer: 'done', tester: 'done', reviewer: 'done' });
});

test('M13 pictureState: a member is working while it has the work, done once finished, idle otherwise', () => {
  const building = { focus: 'implementer', mood: 'working' } as const;
  assert.equal(pictureState('implementer', building, 'running'), 'working');
  assert.equal(pictureState('planner', building, 'done'), 'done');
  assert.equal(pictureState('tester', building, 'pending'), 'idle');
  assert.equal(pictureState('reviewer', building, undefined), 'idle');
  assert.equal(pictureState('reviewer', building, 'skipped'), 'idle');
  // A question: the asker is working (it is mid-step), finished steps stay done.
  assert.equal(pictureState('planner', { focus: 'planner', mood: 'question' }, 'needs_human'), 'working');
  // At a check-in after the plan: the Scout's step is done and waiting.
  assert.equal(pictureState('planner', { focus: 'orchestrator', mood: 'gate' }, 'awaiting_gate'), 'done');
});

test('M13 pictureState: the Queen works while handing over, at check-ins, conflicts and delivery; done once delivered', () => {
  for (const mood of ['handoff', 'gate', 'conflict', 'delivering'] as const) assert.equal(pictureState('orchestrator', { focus: 'orchestrator', mood }), 'working', mood);
  for (const mood of ['working', 'question', 'idle', 'failed'] as const) assert.equal(pictureState('orchestrator', { focus: 'implementer', mood }), 'idle', mood);
  assert.equal(pictureState('orchestrator', { focus: 'orchestrator', mood: 'delivered' }), 'done');
});

test('M13 pictureState: a stopped job leaves nobody working; finished steps stay done', () => {
  const stopped = { focus: 'orchestrator', mood: 'failed' } as const;
  assert.equal(pictureState('implementer', stopped, 'running'), 'idle');
  assert.equal(pictureState('planner', stopped, 'done'), 'done');
});
