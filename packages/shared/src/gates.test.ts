import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGates, GatePolicyError, reviewVerdict, gateAfterRole, blockingTokens, reviewsRepeat } from './gates.js';
import { STANDARD_TEAM } from './team.js';

test('defaults keep every gate required', () => {
  const g = resolveGates(STANDARD_TEAM);
  assert.equal(g.before_merge.mode, 'required');
  assert.equal(g.after_plan.mode, 'required');
});

test('a dispatch may relax after_plan but NOT before_merge', () => {
  const g = resolveGates(STANDARD_TEAM, { request: { after_plan: { mode: 'auto' } } });
  assert.equal(g.after_plan.mode, 'auto');
  assert.throws(() => resolveGates(STANDARD_TEAM, { request: { before_merge: { mode: 'auto' } } }), GatePolicyError);
});

test('a project setting MAY relax before_merge, and then a dispatch can too', () => {
  const g = resolveGates(STANDARD_TEAM, { project: { before_merge: { mode: 'notify' } } });
  assert.equal(g.before_merge.mode, 'notify');
  const g2 = resolveGates(STANDARD_TEAM, { project: { before_merge: { mode: 'auto' } }, request: { before_merge: { mode: 'auto' } } });
  assert.equal(g2.before_merge.mode, 'auto');
});

test('review verdict reads the first line', () => {
  assert.equal(reviewVerdict('APPROVE\n\nlooks good'), 'approve');
  assert.equal(reviewVerdict('REQUEST_CHANGES\n- fix x'), 'request_changes');
  assert.equal(reviewVerdict('ESCALATE\nwe disagree'), 'escalate');
  assert.equal(reviewVerdict('some prose'), null);
  assert.equal(reviewVerdict(null), null);
});

test('reviewsRepeat: same blockers through reformatting are a repeat; a resolved/changed review is not', () => {
  const r1 = 'REQUEST_CHANGES\n- must fix: the header names AGENT_AUTH_MODE but the plan says AUTH_MODE';
  const r2 = 'REQUEST_CHANGES\n\n- **Must fix:** the header names `AGENT_AUTH_MODE`, but the plan says `AUTH_MODE`.'; // same content, reformatted
  assert.equal(reviewsRepeat(r1, r2), true, 'reformatted same blocker is a repeat');
  const r3 = 'REQUEST_CHANGES\n- must fix: the retry loop can spin forever when the socket times out';
  assert.equal(reviewsRepeat(r1, r3), false, 'a genuinely different blocker is not a repeat');
  assert.equal(reviewsRepeat('APPROVE\nlgtm', 'APPROVE\nlgtm'), false, 'no blockers -> never a repeat');
  assert.equal(reviewsRepeat(null, r2), false, 'no previous review -> not a repeat');
});

test('blockingTokens ignores markdown/punctuation noise and short words', () => {
  const a = blockingTokens('REQUEST_CHANGES\n- **Must fix:** the `header` names AGENT_AUTH_MODE!');
  assert.ok(a.has('header') && a.has('agent_auth_mode') && a.has('names'));
  assert.ok(!a.has('the'), 'short words (length ≤ 3) are dropped');
  assert.equal(blockingTokens('APPROVE\nlgtm').size, 0, 'an APPROVE has no blockers');
});

test('gateAfterRole maps planner to after_plan and others to after_role:<role>', () => {
  assert.equal(gateAfterRole('planner'), 'after_plan');
  assert.equal(gateAfterRole('tester'), 'after_role:tester');
});
