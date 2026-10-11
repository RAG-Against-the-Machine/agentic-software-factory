import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_GIT_IDENTITY } from './segment.js';

// Reproduces the container: no global git identity (HOME points at an empty dir).
test('an agent can commit in a container with no git identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asf-ident-'));
  const home = mkdtempSync(join(tmpdir(), 'asf-home-'));
  const base = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none'), EMAIL: '' };
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: base });
  const commit = (env: NodeJS.ProcessEnv) => execFileSync('git', ['-C', dir, '-c', 'user.useConfigOnly=true', 'commit', '-q', '--allow-empty', '-m', 'x'], { env, stdio: 'pipe' });
  assert.throws(() => commit(base), 'baseline: fails without an identity');
  commit({ ...base, ...AGENT_GIT_IDENTITY });
  assert.equal(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%an <%ae>'], { env: base }).toString().trim(), 'asf-bot <factory@users.noreply.github.com>');
});
