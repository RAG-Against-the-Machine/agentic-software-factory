import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_TEAM, DEFAULT_GATES } from './team.js';
import { isForbiddenBranch } from './scm.js';

test('standard team defaults every gate to required', () => {
  assert.equal(STANDARD_TEAM.gates.before_merge.mode, 'required');
  assert.equal(STANDARD_TEAM.gates.after_plan.mode, 'required');
  assert.deepEqual(Object.keys(STANDARD_TEAM.gates).sort(), Object.keys(DEFAULT_GATES).sort());
});

test('protected branches are refused', () => {
  assert.ok(isForbiddenBranch('main'));
  assert.ok(isForbiddenBranch(' Master '));
  assert.ok(!isForbiddenBranch('agent/SWL-139-abc'));
});
