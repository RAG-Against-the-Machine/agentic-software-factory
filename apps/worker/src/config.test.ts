import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRuntimes, codexSandboxMode, inContainer } from './config.js';

test('AGENT_RUNTIMES is a comma list; the deprecated AGENT_RUNTIME only orders, never restricts', () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.deepEqual(agentRuntimes({}, warn), ['claude-code', 'codex'], 'both agents ship in the image; preflight decides which are offered');
  assert.deepEqual(agentRuntimes({ AGENT_RUNTIMES: 'claude-code, codex,codex' }, warn), ['claude-code', 'codex']);
  assert.equal(warnings.length, 0);
  // An upgraded install's .env (written by an old setup.sh) still says AGENT_RUNTIME=claude-code.
  // It must not hide Codex: the legacy value goes first, the other shipped agents follow.
  assert.deepEqual(agentRuntimes({ AGENT_RUNTIME: 'claude-code' }, warn), ['claude-code', 'codex']);
  assert.match(warnings[0], /AGENT_RUNTIME is deprecated and no longer limits this worker to claude-code.*AGENT_RUNTIMES=claude-code/);
  warnings.length = 0;
  assert.deepEqual(agentRuntimes({ AGENT_RUNTIME: 'codex' }, warn), ['codex', 'claude-code']);
  assert.deepEqual(agentRuntimes({ AGENT_RUNTIMES: ' ', AGENT_RUNTIME: 'codex' }, warn), ['codex', 'claude-code'], 'a blank AGENT_RUNTIMES counts as unset');
  assert.deepEqual(agentRuntimes({ AGENT_RUNTIME: '' }, warn), ['claude-code', 'codex'], 'a blank legacy key is ignored');
  warnings.length = 1;
  assert.deepEqual(agentRuntimes({ AGENT_RUNTIMES: 'claude-code', AGENT_RUNTIME: 'codex' }, warn), ['claude-code'], 'the new key wins');
  assert.equal(warnings.length, 1);
});

test('CODEX_SANDBOX auto = off inside a container, workspace-write on a host; explicit values win', () => {
  assert.equal(codexSandboxMode({}, true), 'off');
  assert.equal(codexSandboxMode({ ASF_IN_CONTAINER: '1' }, false), 'off');
  assert.equal(codexSandboxMode({}, false), 'workspace-write');
  assert.equal(codexSandboxMode({ CODEX_SANDBOX: 'workspace-write' }, true), 'workspace-write', 'pin the sandbox on in a container that allows it');
  assert.equal(codexSandboxMode({ CODEX_SANDBOX: 'off' }, false), 'off');
});

test('inContainer: /.dockerenv or ASF_IN_CONTAINER=1', () => {
  assert.equal(inContainer({}, true), true);
  assert.equal(inContainer({ ASF_IN_CONTAINER: '1' }, false), true);
  assert.equal(inContainer({}, false), false);
  assert.equal(inContainer({ ASF_IN_CONTAINER: '0' }, false), false);
});
