import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt, renderConversation, renderChatTurn } from './prompt.js';
import { parseResult, buildArgs, ClaudeCodeRuntime } from './runtimes/claude-code.js';
import { isMissingSession, plannerNote, policyFor, prFeedbackNote } from './segment.js';
import type { AgentSpawn } from '@asf/shared';

const ticket = { id: 't1', key: 'ASF-1', title: 'Add a thing', body: 'Do the thing.', url: 'http://x/ASF-1', links: [] };
const base = { ticket, cwd: '/wt', branch: 'b', artifacts: '/run', prior: {} };

test('planner prompt: asks blocking questions first, otherwise plans with open questions under it', async () => {
  const p = await renderPrompt('planner', 'run_1', base);
  assert.match(p, /NEEDS_HUMAN:` followed by your questions, numbered/);
  assert.match(p, /Open questions/);
  assert.match(p, /rest of the team implements, tests and reviews it on its own/);
  assert.doesNotMatch(p, /CONVERSATION SO FAR/, 'no thread on the first turn');
});

test('a fresh re-run carries the whole conversation, oldest first, and no REVISION banner', async () => {
  const conversation = [
    { author: 'agent' as const, body: '1. Python or Node?' },
    { author: 'human' as const, body: 'Node.', by: 'jon' },
  ];
  const p = await renderPrompt('planner', 'run_1', { ...base, conversation });
  assert.match(p, /## CONVERSATION SO FAR/);
  assert.ok(p.indexOf('Python or Node?') < p.indexOf('**jon:**\nNode.'), 'oldest first');
  assert.doesNotMatch(p, /REVISION REQUESTED/);
  assert.ok(p.indexOf('CONVERSATION SO FAR') < p.indexOf('Run id: run_1'), 'the trailer stays last');
  assert.equal(renderConversation([]), '');
});

test('a resumed turn is just the reply + the protocol reminder', () => {
  const t = renderChatTurn('Use Node\nand vitest', 'jon', '/run');
  assert.match(t, /^jon replied:/);
  assert.match(t, /> Use Node\n> and vitest/);
  assert.match(t, /`\/run\/plan\.md`/);
  assert.match(t, /NEEDS_HUMAN:/);
  assert.doesNotMatch(t, /Do the thing/, 'the resumed session already has the ticket');
});

test('NEEDS_HUMAN keeps every question line, not just the first', () => {
  const env = JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-9',
    result: 'Read the repo.\nNEEDS_HUMAN: I have two questions:\n1. Python or Node?\n2. Which test runner?' });
  const r = parseResult(env);
  assert.equal(r?.outcome, 'needs_human');
  assert.equal(r?.text, 'I have two questions:\n1. Python or Node?\n2. Which test runner?');
  assert.equal(r?.sessionId, 'sess-9', 'the session id is captured for the next turn');
});

test('--resume is passed only when a session is being continued; Claude Code declares it can', () => {
  const spawn = (over: Partial<AgentSpawn> = {}): AgentSpawn => ({ role: 'planner', prompt: 'p', cwd: '/wt', maxCostUsd: 1,
    policy: policyFor(false), env: {}, auth: { providerKind: 'anthropic', mode: 'api-key', credential: 'x' }, timeoutMs: 1, ...over });
  const resumed = buildArgs(spawn({ resumeSessionId: 'sess-9' }), undefined, []);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'sess-9');
  assert.ok(!buildArgs(spawn(), undefined, []).includes('--resume'));
  assert.equal(new ClaudeCodeRuntime().capabilities.resumesSessions, true);
});

test('a vanished session is recognised (the fresh-re-run fallback trigger)', () => {
  // Verbatim from `claude -p hi --resume <unknown uuid>` (exit 1, no envelope, on stderr).
  assert.ok(isMissingSession('No conversation found with session ID: 00000000-0000-4000-8000-000000000000'));
  assert.ok(!isMissingSession('hit the 40-turn ceiling while still working'));
  assert.ok(!isMissingSession(null));
});

test('the planner note falls back to a plain line when the agent said nothing', () => {
  assert.match(plannerNote(''), /approve it, or reply to change it/);
  assert.equal(plannerNote('  I propose X. Confirm Y?  '), 'I propose X. Confirm Y?');
  assert.ok(plannerNote('a'.repeat(3000)).length <= 1501);
});

test('a planner turn from changes requested on the PR is told where the PR is; other turns are not', () => {
  const run = { changeRequestUrl: 'https://github.com/o/r/pull/3' };
  assert.equal(prFeedbackNote({ role: 'planner', queuedBy: 'pr_feedback' }, run),
    'The PR is open at https://github.com/o/r/pull/3; plan the revision on top of it.\n\n');
  assert.equal(prFeedbackNote({ role: 'planner', queuedBy: 'chat' }, run), '');
  assert.equal(prFeedbackNote({ role: 'implementer', queuedBy: 'pr_feedback' }, run), '');
});
