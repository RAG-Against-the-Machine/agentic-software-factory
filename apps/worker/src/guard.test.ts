import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpawn } from '@asf/shared';
import { auditWorktree, watchCancel } from './guard.js';
import { credentialLessUrl } from './git.js';
import { ClaudeCodeRuntime } from './runtimes/claude-code.js';

const exec = promisify(execFile);
const dirs: string[] = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asf-guard-'));
  dirs.push(dir);
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const porcelain = async (dir: string) => (await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir })).stdout.trim();

// ---- credential-less remote ------------------------------------------------

test('credentialLessUrl strips user:token@ and leaves everything else alone', () => {
  assert.equal(credentialLessUrl('https://x-access-token:ghp_SECRET@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(credentialLessUrl('https://oauth2:glpat-SECRET@gitlab.com/g/r.git'), 'https://gitlab.com/g/r.git');
  assert.equal(credentialLessUrl('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(credentialLessUrl('/tmp/some/origin'), '/tmp/some/origin');
});

// ---- post-hoc scope audit --------------------------------------------------

test('auditWorktree: a writing role is never audited', async () => {
  const dir = await repoWith({ 'a.txt': 'one\n' });
  await writeFile(join(dir, 'a.txt'), 'changed\n');
  const r = await auditWorktree({ worktreePath: dir }, true);
  assert.equal(r.violated, false);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'changed\n', 'a writer keeps its edit');
});

test('auditWorktree: a clean read-only role passes', async () => {
  const dir = await repoWith({ 'a.txt': 'one\n' });
  assert.deepEqual(await auditWorktree({ worktreePath: dir }, false), { violated: false, paths: [], untracked: [] });
});

test('auditWorktree: a read-only role that edits/deletes tracked files is a violation, reverted', async () => {
  const dir = await repoWith({ 'a.txt': 'one\n', 'src/b.txt': 'two\n' });
  await writeFile(join(dir, 'a.txt'), 'tampered\n');
  await rm(join(dir, 'src/b.txt'));
  await writeFile(join(dir, 'new.txt'), 'dropped\n');
  const r = await auditWorktree({ worktreePath: dir }, false);
  assert.equal(r.violated, true);
  assert.deepEqual(r.paths.sort(), ['a.txt', 'src/b.txt']);
  assert.deepEqual(r.untracked, ['new.txt']);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(await readFile(join(dir, 'src/b.txt'), 'utf8'), 'two\n');
  assert.equal(await porcelain(dir), '', 'tree is clean again');
});

test('auditWorktree: staged changes are reverted too', async () => {
  const dir = await repoWith({ 'a.txt': 'one\n' });
  await writeFile(join(dir, 'a.txt'), 'staged\n');
  await exec('git', ['add', 'a.txt'], { cwd: dir });
  const r = await auditWorktree({ worktreePath: dir }, false);
  assert.equal(r.violated, true);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(await porcelain(dir), '');
});

test('auditWorktree: untracked leftovers only (test caches) are swept but NOT a violation; ignored files kept', async () => {
  const dir = await repoWith({ '.gitignore': 'node_modules/\n', 'a.py': 'x = 1\n' });
  await mkdir(join(dir, '__pycache__'));
  await writeFile(join(dir, '__pycache__/a.cpython-312.pyc'), 'bytes');
  await mkdir(join(dir, 'node_modules/dep'), { recursive: true });
  await writeFile(join(dir, 'node_modules/dep/index.js'), '');
  const r = await auditWorktree({ worktreePath: dir }, false);
  assert.equal(r.violated, false);
  assert.deepEqual(r.untracked, ['__pycache__/a.cpython-312.pyc']);
  assert.equal(await porcelain(dir), '');
  assert.equal(await readFile(join(dir, 'node_modules/dep/index.js'), 'utf8'), '', 'ignored files are left alone');
});

test('auditWorktree: works on an unborn (empty-repo) worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asf-guard-unborn-'));
  dirs.push(dir);
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await writeFile(join(dir, 'x.txt'), 'x');
  await exec('git', ['add', 'x.txt'], { cwd: dir });
  const r = await auditWorktree({ worktreePath: dir }, false);
  assert.equal(r.violated, true);
  assert.equal(await porcelain(dir), '');
});

// ---- cancel by signal ------------------------------------------------------

test('watchCancel aborts once the poll answers true, and ignores poll errors', async () => {
  let calls = 0;
  const w = watchCancel(async () => { calls++; if (calls === 1) throw new Error('api down'); return calls >= 3; }, 10);
  await new Promise<void>((res) => w.signal.addEventListener('abort', () => res(), { once: true }));
  w.stop();
  assert.equal(w.signal.aborted, true);
  assert.ok(calls >= 3);
});

test('watchCancel.stop() ends polling without aborting', async () => {
  let calls = 0;
  const w = watchCancel(async () => { calls++; return false; }, 10);
  await new Promise((r) => setTimeout(r, 50));
  w.stop();
  const seen = calls;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, seen);
  assert.equal(w.signal.aborted, false);
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('ClaudeCodeRuntime: aborting the RunControl kills the whole process tree and fails the task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asf-guard-bin-'));
  dirs.push(dir);
  // A stand-in `claude` that forks a long-lived grandchild (like a Bash tool running a
  // test server) and then waits forever — no result envelope, only a kill ends it.
  const bin = join(dir, 'fake-claude');
  const pidFile = join(dir, 'grandchild.pid');
  await writeFile(bin, `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\nwait\n`);
  await chmod(bin, 0o755);
  const spawnReq: AgentSpawn = {
    role: 'implementer', prompt: 'x', cwd: dir, maxCostUsd: 1, policy: { fileWrite: 'worktree', shell: true, network: true, gitPush: false }, env: {},
    auth: { providerKind: 'anthropic', mode: 'vertex' }, timeoutMs: 60_000,
  };
  const events: string[] = [];
  const ctl = new AbortController();
  const p = new ClaudeCodeRuntime({ bin }).run(spawnReq, { emit: (e) => events.push(e.kind) }, { signal: ctl.signal });
  let gpid = 0;
  for (let i = 0; i < 100 && !gpid; i++) { await new Promise((r) => setTimeout(r, 20)); gpid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0; }
  assert.ok(gpid && alive(gpid), 'grandchild started');
  ctl.abort();
  const out = await p;
  assert.equal(out.outcome, 'failed');
  assert.equal(out.terminalReason, 'cancelled');
  assert.ok(events.includes('segment:cancelled'));
  for (let i = 0; i < 50 && alive(gpid); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(gpid), false, 'the grandchild died with the group — nothing left writing to the worktree');
});
