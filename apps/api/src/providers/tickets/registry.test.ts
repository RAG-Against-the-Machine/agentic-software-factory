import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TicketProvider } from '@asf/shared';
import { TicketProviderRegistry } from './registry.js';

/** A do-nothing provider whose kind we can assert on. Only the fields the registry touches are real. */
function fake(kind: string): TicketProvider {
  return {
    kind: kind as TicketProvider['kind'],
    async preflight() { return { ok: true as const, identity: `id-${kind}` }; },
    capabilities() { return { subtasks: false, priority: false, links: false, transitions: false, assignable: false, boards: false, sprints: false, statuses: false }; },
    async list() { return { tickets: [] }; },
    async get() { throw new Error('not used'); },
    async update() { throw new Error('not used'); },
    async createSubtask() { throw new Error('not used'); },
    async addLink() {},
    async comment() { return { commentId: 'c' }; },
    async listComments() { return []; },
    async transitions() { return []; },
    async transition() {},
    async assign() {},
    async listScopes() { return []; },
    async listSprints() { return []; },
    async listStatuses() { return []; },
  };
}

test('current() builds once and caches until invalidate()', async () => {
  let builds = 0;
  const kind = 'mock';
  const reg = new TicketProviderRegistry(async (k) => { builds += 1; return fake(k); }, () => kind);

  const a = await reg.current();
  const b = await reg.current();
  assert.equal(builds, 1, 'second current() must not rebuild');
  assert.equal(a, b, 'same instance returned while clean');

  reg.invalidate();
  const c = await reg.current();
  assert.equal(builds, 2, 'invalidate() forces exactly one rebuild');
  assert.notEqual(a, c, 'a fresh instance after invalidate');
  await reg.current();
  assert.equal(builds, 2, 'no rebuild once clean again');
});

test('current() reads the live kind at build time, not a boot snapshot', async () => {
  let kind = 'jira';
  const reg = new TicketProviderRegistry(async (k) => fake(k), () => kind);

  assert.equal((await reg.current()).kind, 'jira');
  kind = 'github';
  // No invalidate yet -> still the cached jira instance.
  assert.equal((await reg.current()).kind, 'jira');
  reg.invalidate();
  assert.equal((await reg.current()).kind, 'github', 'rebuild picks up the new kind');
});

test('concurrent current() during a build share one in-flight build', async () => {
  let builds = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reg = new TicketProviderRegistry(async (k) => { builds += 1; await gate; return fake(k); }, () => 'mock');

  const p1 = reg.current();
  const p2 = reg.current();
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(builds, 1, 'two concurrent callers trigger exactly one build');
  assert.equal(a, b);
});

test('an invalidate() arriving mid-build re-dirties so the next current() rebuilds', async () => {
  let builds = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const reg = new TicketProviderRegistry(async (k) => { builds += 1; await gate; return fake(k); }, () => 'mock');

  const inflight = reg.current();
  reg.invalidate();      // arrives while the first build is still pending
  release();
  await inflight;
  assert.equal(builds, 1);
  await reg.current();   // must rebuild because we were re-dirtied mid-build
  assert.equal(builds, 2, 'invalidate during a build is not lost');
});

test('a failed build re-dirties so the next current() retries', async () => {
  let builds = 0;
  const reg = new TicketProviderRegistry(async (k) => {
    builds += 1;
    if (builds === 1) throw new Error('boom');
    return fake(k);
  }, () => 'mock');

  await assert.rejects(reg.current(), /boom/);
  const p = await reg.current();
  assert.equal(builds, 2, 'a failed build does not get cached; next call retries');
  assert.equal(p.kind, 'mock');
});

test('live proxy forwards to the current instance and survives a hot-swap', async () => {
  let kind = 'jira';
  const reg = new TicketProviderRegistry(async (k) => fake(k), () => kind);

  // Force the first build via a forwarded call.
  assert.deepEqual(await reg.live.preflight(), { ok: true, identity: 'id-jira' });
  assert.equal(reg.live.kind, 'jira');

  kind = 'github';
  reg.invalidate();
  assert.deepEqual(await reg.live.preflight(), { ok: true, identity: 'id-github' }, 'proxy reflects the swap');
  assert.equal(reg.live.kind, 'github');
});
