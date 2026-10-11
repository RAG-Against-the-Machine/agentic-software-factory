import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeCapabilities } from '@asf/shared';
import { policyFor, needsHeartbeat } from './segment.js';

// The worker decides a role's permissions neutrally (M8 WP B); each runtime translates.
// WHERE a role may write (run dir only vs also the worktree) is the policy's fileWrite;
// Claude enforces it in the PreToolUse hook, every runtime gets the guard-layer audit.
test('policyFor: a writer may write the worktree, a reader only its run-dir artifact; nobody pushes', () => {
  assert.deepEqual(policyFor(true), { fileWrite: 'worktree', shell: true, network: true, gitPush: false });
  assert.deepEqual(policyFor(false), { fileWrite: 'run-dir-only', shell: true, network: true, gitPush: false });
});

test('needsHeartbeat only for a runtime that is otherwise silent (no hooks, no event stream)', () => {
  const caps = (toolHooks: boolean, eventStream: boolean): RuntimeCapabilities => ({ toolHooks, eventStream, reportsCost: false, listsModels: false, confinesWrites: false });
  assert.equal(needsHeartbeat(caps(true, false)), false, 'claude-code: hooks post tool events');
  assert.equal(needsHeartbeat(caps(false, true)), false, 'codex: JSONL stream');
  assert.equal(needsHeartbeat(caps(false, false)), true, 'copilot-style: silent');
});
