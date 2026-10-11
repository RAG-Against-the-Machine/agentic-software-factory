import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './index.js';

test('loadRuntime dispatches on kind; the concrete runtime is confined to this factory', () => {
  assert.equal(loadRuntime('claude-code').kind, 'claude-code');
  assert.equal(loadRuntime('codex').kind, 'codex');
  assert.equal(loadRuntime('opencode').kind, 'opencode');
  assert.equal(loadRuntime('copilot').kind, 'copilot');
  assert.throws(() => loadRuntime('nope'), /Unknown AGENT_RUNTIME: nope/);
});

test('a runtime whose binary is missing probes false, so no worker advertises it', async () => {
  const { CodexRuntime } = await import('./codex.js');
  const probe = await new CodexRuntime({ bin: '/nonexistent/codex' }).probe();
  assert.equal(probe.ok, false);
});
