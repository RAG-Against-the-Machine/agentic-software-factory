import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRunRoutes } from './runs.js';
import { config } from '../config.js';
import { MockTicketProvider } from '../providers/tickets/mock.js';
import { MockScmProvider } from '../providers/scm/mock.js';

// GET /api/runs/:id/cancel-requested (M8 WP A): how a hookless runtime learns of a
// cancel. Worker-only, so it is behind X-Run-Secret like /context and /events.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function stubGetRun(run: { cancelRequestedAt: string | null } | null) {
  global.fetch = (async () => new Response(JSON.stringify({ ok: true, result: run ? { run, tasks: [] } : null }),
    { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

async function app() {
  const a = Fastify();
  registerRunRoutes(a, { tickets: new MockTicketProvider(), scm: new MockScmProvider() });
  await a.ready();
  return a;
}
const secret = () => ({ 'x-run-secret': config.runEventSecret });

test('cancel-requested: true once the run carries cancelRequestedAt', async () => {
  stubGetRun({ cancelRequestedAt: new Date().toISOString() });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1/cancel-requested', headers: secret() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { cancelRequested: true });
  await a.close();
});

test('cancel-requested: false for a live run and for an unknown run', async () => {
  const a = await app();
  stubGetRun({ cancelRequestedAt: null });
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/runs/run_1/cancel-requested', headers: secret() })).json(), { cancelRequested: false });
  stubGetRun(null);
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/runs/nope/cancel-requested', headers: secret() })).json(), { cancelRequested: false });
  await a.close();
});

test('cancel-requested: refused without the run secret', async () => {
  stubGetRun({ cancelRequestedAt: null });
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/api/runs/run_1/cancel-requested', headers: { 'x-run-secret': 'wrong' } });
  assert.equal(res.statusCode, 401);
  await a.close();
});
