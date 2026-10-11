import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { updateStatusSchema } from '@asf/shared';
import { registerUpdateRoutes } from './updates.js';
import { __resetUpdates } from '../updates.js';

// The registry is reached over the global fetch; stub it.
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.ASF_BUILD_VERSION;
  delete process.env.ASF_LOCAL_SUPERVISOR;
  delete process.env.SUPERVISOR_URL;
  __resetUpdates();
});

async function app() {
  const a = Fastify();
  registerUpdateRoutes(a);
  await a.ready();
  return a;
}

test('GET /api/updates before any check: current version, nothing known yet', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  const r = await (await app()).inject({ method: 'GET', url: '/api/updates' });
  assert.equal(r.statusCode, 200);
  const s = updateStatusSchema.parse(r.json());
  assert.deepEqual(s, { current: 'v0.1.0', latest: null, available: false, checkedAt: null, error: null, canApply: false });
});

test('POST /api/updates/check runs a check and GET then returns it', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  global.fetch = (async (url: string) => new Response(JSON.stringify(String(url).includes('/token') ? { token: 't' } : { tags: ['v0.2.0', 'latest'] }),
    { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const a = await app();
  const r = await a.inject({ method: 'POST', url: '/api/updates/check' });
  assert.equal(r.statusCode, 200);
  const s = updateStatusSchema.parse(r.json());
  assert.equal(s.latest, 'v0.2.0');
  assert.equal(s.available, true);
  assert.equal(s.canApply, false);
  const g = updateStatusSchema.parse((await a.inject({ method: 'GET', url: '/api/updates' })).json());
  assert.deepEqual(g, s);
});

test('POST /api/updates/check with the registry down: 200 with the error', async () => {
  global.fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const r = await (await app()).inject({ method: 'POST', url: '/api/updates/check' });
  assert.equal(r.statusCode, 200);
  assert.equal(updateStatusSchema.parse(r.json()).error, 'fetch failed');
});

// --- apply (ADHOC-9B0D5947) ---

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * One fetch stub for all three peers: the image registry (tags), the asf registry
 * (listFleet), and the supervisor (/update). Records supervisor calls with their bodies.
 */
function stubAll(opts: { tags?: string[]; running?: number | 'down'; supervisor?: (body: unknown) => Response } = {}) {
  const supervisorCalls: Array<{ url: string; body: unknown }> = [];
  global.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/token')) return json(200, { token: 't' });
    if (u.includes('/tags/list')) return json(200, { tags: opts.tags ?? ['v0.2.0'] });
    if (u.endsWith('/internal/rpc')) {
      if (opts.running === 'down') throw new TypeError('fetch failed');
      return json(200, { ok: true, result: { workers: [], capacity: 1, running: opts.running ?? 0 } });
    }
    const body = JSON.parse(init?.body ?? 'null') as unknown;
    supervisorCalls.push({ url: u, body });
    return (opts.supervisor ?? (() => json(200, { running: true, version: 'v0.2.0' })))(body);
  }) as unknown as typeof fetch;
  return supervisorCalls;
}

async function appAfterCheck() {
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/updates/check' });
  return a;
}
const apply = async (a: Awaited<ReturnType<typeof app>>) => a.inject({ method: 'POST', url: '/api/updates/apply' });

test('apply: refused without a local supervisor; canApply is false', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  const calls = stubAll();
  const a = await appAfterCheck();
  assert.equal((await a.inject({ method: 'GET', url: '/api/updates' })).json().canApply, false);
  const r = await apply(a);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json(), { error: 'refused', reason: 'no local supervisor in this deployment; run scripts/asf update on the host' });
  assert.equal(calls.length, 0);
});

test('apply: refused when no newer release is known', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.2.0';
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  const calls = stubAll();
  const a = await appAfterCheck();
  assert.equal((await a.inject({ method: 'GET', url: '/api/updates' })).json().canApply, false);
  const r = await apply(a);
  assert.equal(r.statusCode, 409);
  assert.match(r.json().reason, /no newer release/);
  assert.equal(calls.length, 0);
});

test('apply: refused while a task is running, or when the registry is down', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  let calls = stubAll({ running: 2 });
  const a = await appAfterCheck();
  assert.equal((await a.inject({ method: 'GET', url: '/api/updates' })).json().canApply, true, 'busy workers do not affect canApply');
  let r = await apply(a);
  assert.equal(r.statusCode, 409);
  assert.match(r.json().reason, /2 task\(s\) are running/);
  assert.equal(calls.length, 0);

  calls = stubAll({ running: 'down' });
  r = await apply(a);
  assert.equal(r.statusCode, 409);
  assert.match(r.json().reason, /registry cannot be reached/);
  assert.equal(calls.length, 0);
});

test('apply: the supervisor refusing is passed through as a 409 with its reason', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  stubAll({ supervisor: () => json(409, { error: 'refused', reason: 'an update is already running' }) });
  const r = await apply(await appAfterCheck());
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json(), { error: 'refused', reason: 'an update is already running' });
});

test('apply: a supervisor failure is a 502', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  stubAll({ supervisor: () => json(502, { error: 'docker_error', reason: 'docker pull docker:cli: 500' }) });
  const r = await apply(await appAfterCheck());
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().reason, 'docker pull docker:cli: 500');
});

test('apply: posts the latest release to the supervisor', async () => {
  process.env.ASF_BUILD_VERSION = 'v0.1.0';
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  process.env.SUPERVISOR_URL = 'http://sup:1/';
  const calls = stubAll({ tags: ['v0.2.0', 'v0.3.1', 'latest'] });
  const r = await apply(await appAfterCheck());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { started: true, version: 'v0.3.1' });
  assert.deepEqual(calls, [{ url: 'http://sup:1/update', body: { version: 'v0.3.1' } }]);
});
