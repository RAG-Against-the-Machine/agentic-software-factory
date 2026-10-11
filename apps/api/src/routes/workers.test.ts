import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerWorkerRoutes } from './workers.js';

// The supervisor is reached over fetch; stub it and record what was proxied.
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.ASF_LOCAL_SUPERVISOR;
  delete process.env.SUPERVISOR_URL;
});

function stubSupervisor(reply: (method: string, url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  global.fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    return reply(method, url);
  }) as unknown as typeof fetch;
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function app() {
  const a = Fastify();
  registerWorkerRoutes(a);
  await a.ready();
  return a;
}

test('flag off: unavailable, and the supervisor is never called', async () => {
  const calls = stubSupervisor(() => json(200, { state: 'running', exitCode: 0, restartCount: 0 }));
  const a = await app();
  const r = await a.inject({ method: 'GET', url: '/api/workers/local' });
  assert.equal(r.json().available, false);
  const s = await a.inject({ method: 'POST', url: '/api/workers/local/start' });
  assert.equal(s.statusCode, 409);
  assert.equal(calls.length, 0);
});

test('supervisor down: unavailable with a reason (not a 500)', async () => {
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  stubSupervisor(() => { throw new TypeError('fetch failed'); });
  const a = await app();
  const r = await a.inject({ method: 'GET', url: '/api/workers/local' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().available, false);
  assert.match(r.json().reason, /unreachable/);
  const s = await a.inject({ method: 'POST', url: '/api/workers/local/start' });
  assert.equal(s.statusCode, 502);
});

for (const [state, exitCode, restartCount] of [['running', 0, 0], ['exited', 137, 0], ['restarting', 1, 9], ['missing', null, null]] as const) {
  test(`state ${state} is passed through`, async () => {
    process.env.ASF_LOCAL_SUPERVISOR = '1';
    process.env.SUPERVISOR_URL = 'http://sup:1/';
    const calls = stubSupervisor(() => json(200, { state, exitCode, restartCount }));
    const r = await (await app()).inject({ method: 'GET', url: '/api/workers/local' });
    assert.deepEqual(r.json(), { available: true, state, exitCode, restartCount });
    assert.deepEqual(calls, ['GET http://sup:1/status']);
  });
}

test('a malformed supervisor answer is unavailable', async () => {
  process.env.ASF_LOCAL_SUPERVISOR = 'true';
  stubSupervisor(() => json(200, { state: 'weird' }));
  const r = await (await app()).inject({ method: 'GET', url: '/api/workers/local' });
  assert.equal(r.json().available, false);
});

test('start is proxied to POST /start and returns the new state', async () => {
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  const calls = stubSupervisor(() => json(200, { state: 'running', exitCode: 0, restartCount: 0 }));
  const r = await (await app()).inject({ method: 'POST', url: '/api/workers/local/start' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { available: true, state: 'running', exitCode: 0, restartCount: 0 });
  assert.deepEqual(calls, ['POST http://supervisor:8791/start']);
});

test('a supervisor refusal (no container) comes back as 409 with its reason', async () => {
  process.env.ASF_LOCAL_SUPERVISOR = '1';
  stubSupervisor(() => json(409, { error: 'refused', reason: 'no asf worker container exists; run ./scripts/asf up' }));
  const r = await (await app()).inject({ method: 'POST', url: '/api/workers/local/start' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().reason, /asf up/);
});
