import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimResponse, RunContext, Run, RunAuth } from '@asf/shared';
import { STANDARD_TEAM, DEFAULT_GATES, googleLoginFix } from '@asf/shared';

// M9 #2: a Vertex run that fails on the Google login emits `auth:expired` and returns a
// plain-words reason. Drives the real runSegment (reviewer = read-only, so no git checkout)
// against a fake `claude` binary whose JSON result envelope is controlled per test.

let dir: string;
let segment: typeof import('./segment.js');
let apiMod: typeof import('./api.js');
let cfg: typeof import('./config.js');

type Ev = { kind: string; payload: Record<string, unknown> };
let events: Ev[] = [];
const realApi = {} as Record<string, unknown>;
const PATCHED = ['event', 'saveArtifact', 'listArtifacts', 'listArtifactVersions', 'listMessages', 'listAdhoc', 'cancelRequested', 'appendMessage', 'createAdhoc', 'attachment'] as const;

/** A fake claude: `--version` works; any other call prints a result envelope with `result` text. */
async function fakeClaude(isError: boolean, text: string): Promise<string> {
  const bin = join(dir, `claude-${Math.random().toString(36).slice(2)}`);
  const envelope = JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text, num_turns: 1, total_cost_usd: 0 });
  await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\ncat <<'EOF'\n${envelope}\nEOF\n`);
  await chmod(bin, 0o755);
  return bin;
}

const run = (): Run => ({
  id: 'run_login00001', ticketId: 't1', ticketKey: 'ASF-9', ticketProvider: 'mock', state: 'running',
  teamName: 'standard', team: STANDARD_TEAM, gates: DEFAULT_GATES, repoId: null, worktreePath: null, branchName: null,
  changeRequestUrl: null, changeRequestNumber: null, changeRequestState: null, deliveryOutcome: null, costUsd: 0, maxCostUsd: 15, reviewIterations: 0, dispatchedBy: 'test', reason: null,
  createdAt: new Date().toISOString(), startedAt: null, lastEventAt: null, cancelRequestedAt: null, finishedAt: null,
});
const claim = (): ClaimResponse & object => ({
  run: run(), team: STANDARD_TEAM,
  task: { id: 'task_login1', runId: 'run_login00001', role: 'reviewer', seq: 3, state: 'running', attempt: 1, inputRef: null, outputRef: null,
    workerId: 'w', runtime: 'claude-code', model: null, effort: null, costUsd: 0, gateChecked: false, startedAt: null, finishedAt: null,
    reason: null, queuedBy: 'plan', queuedReason: null },
}) as unknown as ClaimResponse & object;
const ctx = (auth: RunAuth): RunContext => ({
  runId: 'run_login00001', ticket: { id: 't1', key: 'ASF-9', title: 'T', body: 'B', url: 'u', links: [] },
  repo: null, cloneCredential: null, auth, auths: {}, roleSkills: {}, thirdPartySkills: [],
}) as unknown as RunContext;
const vertex: RunAuth = { providerKind: 'anthropic', mode: 'vertex', vertex: { projectId: 'acme-ai', region: 'global' } } as RunAuth;
const apiKey: RunAuth = { providerKind: 'anthropic', mode: 'api-key', credential: 'sk-test' } as RunAuth;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asf-seglogin-'));
  process.env.RUN_DATA_ROOT = join(dir, 'runs');
  process.env.WORKTREE_ROOT = join(dir, 'wt');
  process.env.WORKER_ID = 'worker-test-1';
  cfg = await import('./config.js');
  apiMod = await import('./api.js');
  segment = await import('./segment.js');
  defaultConfirm = segment.googleLogin.confirm;
  for (const k of PATCHED) realApi[k] = (apiMod.api as Record<string, unknown>)[k];
});
after(async () => {
  for (const k of PATCHED) (apiMod.api as Record<string, unknown>)[k] = realApi[k];
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  events = [];
  const a = apiMod.api as Record<string, unknown>;
  a.event = async (_runId: string, kind: string, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  a.saveArtifact = async () => {};
  a.listArtifacts = async () => ({});
  a.listArtifactVersions = async () => [];
  a.listMessages = async () => [];
  a.listAdhoc = async () => [];
  a.cancelRequested = async () => false;
  a.appendMessage = async () => {};
  a.createAdhoc = async () => null;
  a.attachment = async () => Buffer.from('');
});
const kinds = () => events.map((e) => e.kind);
/** googleLogin.confirm is a mutable seam (index.ts wires the real LoginWatch); pin it per test, restore after each. */
let defaultConfirm: () => Promise<boolean>;
const confirmAs = (v: boolean) => { segment.googleLogin.confirm = async () => v; };
afterEach(() => { segment.googleLogin.confirm = defaultConfirm; });
const useBin = async (isError: boolean, text: string) => { (cfg.config as { claudeBin: string }).claudeBin = await fakeClaude(isError, text); };

test('vertex + a Google login failure CONFIRMED by the login watch: emits auth:expired, fails with the plain reason, flags googleLoginFailed', async () => {
  confirmAs(true);
  await useBin(true, 'API Error: 400 {"error":"invalid_grant","error_description":"Token has been expired or revoked."}');
  const res = await segment.runSegment(claim(), ctx(vertex), () => {});
  assert.equal(res.outcome, 'failed');
  assert.equal(res.googleLoginFailed, true);
  const id = cfg.config.id;
  assert.ok(res.reason?.includes(`The Google login on worker ${id} has expired`), res.reason ?? '');
  assert.ok(res.reason?.includes(googleLoginFix(id)));
  assert.match(res.reason ?? '', /Retry role/);
  assert.doesNotMatch(res.reason ?? '', /invalid_grant/, 'the raw auth error is replaced');

  const ev = events.find((e) => e.kind === 'auth:expired');
  assert.ok(ev, `events: ${kinds().join(',')}`);
  assert.equal(ev.payload.role, 'reviewer');
  assert.equal(ev.payload.worker, id);
  assert.equal(ev.payload.provider, 'vertex');
  assert.equal(ev.payload.reason, res.reason);
  assert.ok(!('detail' in ev.payload), 'the raw error is not put on the event');
  assert.deepEqual(Object.keys(ev.payload).sort(), ['provider', 'reason', 'role', 'worker']);
  assert.equal(events.filter((e) => e.kind === 'auth:expired').length, 1);
  // The segment:result event reports the rewritten outcome, and comes after auth:expired.
  assert.ok(kinds().indexOf('auth:expired') < kinds().indexOf('segment:result'));
  assert.equal(events.find((e) => e.kind === 'segment:result')!.payload.outcome, 'failed');
});

test('vertex + a Google-looking failure the login watch does NOT confirm: the original failure text is kept, no auth:expired', async () => {
  confirmAs(false);
  const raw = 'API Error: 400 {"error":"invalid_grant","error_description":"Token has been expired or revoked."}';
  await useBin(true, raw);
  const res = await segment.runSegment(claim(), ctx(vertex), () => {});
  assert.equal(res.outcome, 'failed');
  assert.ok(!('googleLoginFailed' in res));
  assert.equal(res.reason, raw);
  assert.ok(!kinds().includes('auth:expired'));
});

test('the default googleLogin.confirm (nothing wired) confirms nothing', async () => {
  assert.equal(await segment.googleLogin.confirm(), false);
});

test('a confirm() that rejects is treated as not confirmed', async () => {
  segment.googleLogin.confirm = async () => { throw new Error('boom'); };
  await useBin(true, 'API Error: 400 {"error":"invalid_grant"}');
  const res = await segment.runSegment(claim(), ctx(vertex), () => {});
  assert.equal(res.reason, 'API Error: 400 {"error":"invalid_grant"}');
  assert.ok(!kinds().includes('auth:expired'));
});

test('api-key mode failing with the same text is NOT treated as a Google login failure', async () => {
  const raw = 'API Error: 400 {"error":"invalid_grant"}';
  await useBin(true, raw);
  const res = await segment.runSegment(claim(), ctx(apiKey), () => {});
  assert.equal(res.outcome, 'failed');
  assert.equal(res.googleLoginFailed, undefined);
  assert.ok(!('googleLoginFailed' in res));
  assert.equal(res.reason, raw, 'reason untouched');
  assert.ok(!kinds().includes('auth:expired'));
});

test('vertex mode with an unrelated failure: untouched', async () => {
  await useBin(true, 'API Error: 429 rate limit exceeded');
  const res = await segment.runSegment(claim(), ctx(vertex), () => {});
  assert.equal(res.outcome, 'failed');
  assert.ok(!('googleLoginFailed' in res));
  assert.equal(res.reason, 'API Error: 429 rate limit exceeded');
  assert.ok(!kinds().includes('auth:expired'));
});

test('vertex mode, a successful run that merely mentions invalid_grant: untouched', async () => {
  await useBin(false, 'Review done. The code handles invalid_grant by prompting a re-login. APPROVE');
  const res = await segment.runSegment(claim(), ctx(vertex), () => {});
  assert.notEqual(res.outcome, 'failed');
  assert.ok(!('googleLoginFailed' in res));
  assert.ok(!kinds().includes('auth:expired'));
});
