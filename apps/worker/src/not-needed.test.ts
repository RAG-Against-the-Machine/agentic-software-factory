import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt, renderConversation, renderChatTurn } from './prompt.js';
import { outcomeFromText } from './runtimes/outcome.js';
import { isNotNeeded, notNeededReason } from '@asf/shared';

/**
 * A ticket the factory filed for itself can be out of date, or about a problem the
 * install doesn't have. The planner (or the implementer, when planning is off) checks
 * first and says NOT_NEEDED: with evidence; a person confirms and cancels the job.
 * Motivating case: ADHOC-D2EFB556, where the planner was asked twice "is this needed?"
 * and answered each time by repeating its design question.
 */
const ticket = { id: 't1', key: 'ASF-1', title: 'Add a thing', body: 'Do the thing.', url: 'http://x/ASF-1', links: [] };
const base = { ticket, cwd: '/wt', branch: 'b', artifacts: '/run', prior: { 'plan.md': 'THE PLAN', 'test-report.md': 'R' } };

test('NOT_NEEDED: parks the task, tagged so the UI offers to cancel, with all the evidence', () => {
  const r = outcomeFromText('Checked main.\nNOT_NEEDED: Already on main in supervisor.ts:174.\nAlso documented in UPGRADING.md.');
  assert.equal(r.outcome, 'needs_human');
  assert.ok(isNotNeeded(r.text));
  assert.equal(notNeededReason(r.text ?? ''), 'Already on main in supervisor.ts:174.\nAlso documented in UPGRADING.md.');
});

test('NOT_NEEDED wins over a NEEDS_HUMAN in the same reply; plain questions are unchanged', () => {
  assert.ok(isNotNeeded(outcomeFromText('NEEDS_HUMAN: which?\nNOT_NEEDED: done in #12').text));
  const q = outcomeFromText('NEEDS_HUMAN: Python or Node?');
  assert.equal(q.text, 'Python or Node?');
  assert.ok(!isNotNeeded(q.text));
  assert.equal(outcomeFromText('All done.').outcome, 'done');
});

test('the planner checks the work is needed before planning, against the freshly fetched code', async () => {
  const p = await renderPrompt('planner', 'run_1', base);
  assert.match(p, /\*\*First, check the work is still needed\*\*/);
  assert.match(p, /`NOT_NEEDED:`/);
  assert.match(p, /fetched the remote just before this turn/);
  assert.match(p, /don't ask the person to check GitHub for you/);
  assert.ok(p.indexOf('NOT_NEEDED:') < p.indexOf('If at any point you are blocked'), 'the rule sits in the trailer, before the NEEDS_HUMAN protocol');
});

test('the implementer may say NOT_NEEDED (planning can be off); the tester and reviewer may not', async () => {
  assert.match(await renderPrompt('implementer', 'run_1', base), /`NOT_NEEDED:`/);
  assert.doesNotMatch(await renderPrompt('tester', 'run_1', base), /NOT_NEEDED/);
  assert.doesNotMatch(await renderPrompt('reviewer', 'run_1', base), /NOT_NEEDED/);
});

test("a chat turn answers the person's question first and doesn't repeat an old question word for word", async () => {
  const resumed = renderChatTurn('Is this work actually needed?', 'jon', '/run');
  const fresh = renderConversation([{ author: 'agent', body: '1. Pin or refuse?' }, { author: 'human', body: 'Is this needed?', by: 'jon' }]);
  for (const t of [resumed, fresh]) {
    assert.match(t, /\*\*Answer it first, directly\*\*/);
    assert.match(t, /lead with a plain yes or no and the evidence/);
    assert.match(t, /Don't repeat a question they have already seen word for word/);
    assert.match(t, /`NOT_NEEDED:`/);
    assert.match(t, /`NEEDS_HUMAN:`/);
  }
  assert.match(resumed, /`\/run\/plan\.md`/);
});

test('follow-ups must be checked, not what-ifs', async () => {
  for (const role of ['planner', 'implementer']) {
    assert.match(await renderPrompt(role, 'run_1', base), /only work you've checked is needed/);
  }
});
