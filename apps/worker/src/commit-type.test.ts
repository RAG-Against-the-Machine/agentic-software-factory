import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeType } from './commit-type.js';

test('the reviewer\'s Change-Type wins over the planner\'s', () => {
  assert.equal(changeType('APPROVE\nfine\n\nChange-Type: feat\n', '# Plan\n\nChange-Type: fix\n'), 'feat');
});

test('the planner\'s Change-Type is used when the review has none', () => {
  assert.equal(changeType('APPROVE\nlooks right', '# Plan\n- x\n\nChange-Type: docs'), 'docs');
  assert.equal(changeType(null, 'Change-Type: feat!'), 'feat!');
});

test('no Change-Type line, or an unknown one, defaults to fix', () => {
  assert.equal(changeType(undefined, undefined), 'fix');
  assert.equal(changeType('APPROVE', '# Plan'), 'fix');
  assert.equal(changeType('Change-Type: perf', 'Change-Type: banana'), 'fix');
});

test('tolerates markdown emphasis and case, and takes the last valid line', () => {
  assert.equal(changeType('**Change-Type:** `chore`', null), 'chore');
  assert.equal(changeType('change-type: REFACTOR', null), 'refactor');
  assert.equal(changeType('Change-Type: fix\n…\nChange-Type: ci', null), 'ci');
  assert.equal(changeType('Change-Type: feat!', null), 'feat!');
});
