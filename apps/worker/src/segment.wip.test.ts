import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repo, Run } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES } from '@asf/shared';

const exec = promisify(execFile);

// git.ts / segment.ts read config.worktreeRoot at call time; point it at a temp dir before importing.
let root: string;
let originDir: string;
let git: typeof import('./git.js');
let segment: typeof import('./segment.js');

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_wip00000001', ticketId: 't1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: 'r1', worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null, ...over,
});
const repo = (): Repo => ({ id: 'r1', path: 'example/app', url: 'file://origin', defaultBranch: 'main', cloneUrl: originDir });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'asf-wip-wt-'));
  process.env.WORKTREE_ROOT = root;
  git = await import('./git.js');
  segment = await import('./segment.js');
  originDir = await mkdtemp(join(tmpdir(), 'asf-wip-origin-'));
  await exec('git', ['init', '-b', 'main', originDir]);
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: originDir });
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(originDir, { recursive: true, force: true }); });

type Ev = { kind: string; payload: Record<string, unknown> };
const sink = () => { const events: Ev[] = []; return { events, emit: (kind: string, payload: Record<string, unknown>) => events.push({ kind, payload }) }; };
const subject = async (cwd: string) => (await exec('git', ['log', '-1', '--format=%s'], { cwd })).stdout.trim();

test('failed + dirty tree → one wip(implementer) commit + segment:wip_committed event', async () => {
  const r = run({ id: 'run_wipfail0001' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  assert.equal(await git.wipAtHead(ws, 'implementer'), null, 'a fresh HEAD is not a WIP commit');
  await writeFile(join(ws.worktreePath, 'partial.ts'), 'half a feature\n');
  const s = sink();
  await segment.commitWipIfCutShort(ws, r, 'implementer', 'failed', 'ran out of turns\nmid-edit', s.emit, () => {});

  assert.match(await subject(ws.worktreePath), /^wip\(implementer\): ASF-9 — outcome: ran out of turns mid-edit$/);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].kind, 'segment:wip_committed');
  assert.equal(s.events[0].payload.files, 1);
  // wipAtHead surfaces the reason so a re-run's prompt can continue from it.
  assert.equal(await git.wipAtHead(ws, 'implementer'), 'ran out of turns mid-edit');
  // A different role's WIP probe does not match this commit.
  assert.equal(await git.wipAtHead(ws, 'tester'), null);
});

test('timeout + dirty tree also produces a wip commit', async () => {
  const r = run({ id: 'run_wiptmo0001' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  await writeFile(join(ws.worktreePath, 'partial.ts'), 'half a feature\n');
  const s = sink();
  await segment.commitWipIfCutShort(ws, r, 'implementer', 'timeout', 'segment timed out', s.emit, () => {});
  assert.equal(s.events.length, 1);
  assert.match(await subject(ws.worktreePath), /^wip\(implementer\):/);
});

test('needs_human → no wip commit, tree left dirty', async () => {
  const r = run({ id: 'run_wipnh000001' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  await writeFile(join(ws.worktreePath, 'partial.ts'), 'a question, not a change\n');
  const s = sink();
  await segment.commitWipIfCutShort(ws, r, 'implementer', 'needs_human', 'asked a question', s.emit, () => {});
  assert.equal(s.events.length, 0);
  assert.equal(await git.wipAtHead(ws, 'implementer'), null);
  const status = (await exec('git', ['status', '--porcelain'], { cwd: ws.worktreePath })).stdout.trim();
  assert.notEqual(status, '', 'the uncommitted work is untouched');
});

test('done → no wip commit (the done path commits separately)', async () => {
  const r = run({ id: 'run_wipdone0001' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  await writeFile(join(ws.worktreePath, 'done.ts'), 'finished\n');
  const s = sink();
  await segment.commitWipIfCutShort(ws, r, 'implementer', 'done', null, s.emit, () => {});
  assert.equal(s.events.length, 0);
  assert.equal(await git.wipAtHead(ws, 'implementer'), null);
});

test('failed + clean tree → nothing to commit, no event', async () => {
  const r = run({ id: 'run_wipclean001' });
  const ws = await git.ensureWorkspace(r, repo(), { url: originDir }, () => {});
  const s = sink();
  await segment.commitWipIfCutShort(ws, r, 'implementer', 'failed', 'nothing was written', s.emit, () => {});
  assert.equal(s.events.length, 0);
  assert.equal(await git.wipAtHead(ws, 'implementer'), null);
});
