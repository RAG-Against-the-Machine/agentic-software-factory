import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { VertexCheckResult } from '@asf/shared';
import { config } from '../config.js';
import { VertexChecks } from '../vertex-checks.js';
import { registerVertexRoutes } from './vertex.js';

const secret = () => ({ 'x-run-secret': config.runEventSecret });

async function setup() {
  const checks = new VertexChecks();
  const a = Fastify();
  registerVertexRoutes(a, checks);
  await a.ready();
  return { a, checks };
}

const goodBody = { projectId: 'my-team-ai', region: 'global', models: ['claude-sonnet-5'] };
const result = (): VertexCheckResult => ({
  ok: true, login: { ok: true, account: 'me@example.com', kind: 'authorized_user' },
  models: [{ id: 'claude-sonnet-5', tier: 'balanced', ok: true }],
  claudeCode: { ok: true, model: 'claude-sonnet-5' }, checkedAt: '2026-01-01T00:00:00.000Z',
});

test('POST check: a display name is a 400 bad_project; a bad region a 400 bad_region; a malformed body a 400 bad_request', async () => {
  const { a } = await setup();
  const proj = await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: { ...goodBody, projectId: 'My Project' } });
  assert.equal(proj.statusCode, 400);
  assert.equal(proj.json().error, 'bad_project');
  const reg = await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: { ...goodBody, region: 'Mars' } });
  assert.equal(reg.statusCode, 400);
  assert.equal(reg.json().error, 'bad_region');
  const empty = await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: { ...goodBody, models: [] } });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, 'bad_request');
  await a.close();
});

test('POST check: a good request returns an id that the browser can poll as queued', async () => {
  const { a } = await setup();
  const res = await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: goodBody });
  assert.equal(res.statusCode, 200);
  const { id } = res.json() as { id: string };
  assert.ok(id);
  const got = await a.inject({ method: 'GET', url: `/api/providers/vertex/check/${id}` });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().state, 'queued');
  assert.equal((await a.inject({ method: 'GET', url: '/api/providers/vertex/check/unknown' })).statusCode, 404);
  await a.close();
});

test('POST check: trims fields and dedupes model ids', async () => {
  const { a } = await setup();
  const res = await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: {
    projectId: ' my-team-ai ', region: ' us-east5 ', models: ['claude-sonnet-5', ' claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-5'],
  } });
  assert.equal(res.statusCode, 200);
  const next = await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/next', headers: secret(), payload: { worker: 'w1' } });
  assert.deepEqual(next.json().check.request, { projectId: 'my-team-ai', region: 'us-east5', models: ['claude-sonnet-5', 'claude-opus-4-8'] });
  await a.close();
});

test('worker routes without a (or with the wrong) X-Run-Secret are 401', async () => {
  const { a } = await setup();
  const none = await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/next', payload: { worker: 'w1' } });
  assert.equal(none.statusCode, 401);
  const wrong = await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/abc', headers: { 'x-run-secret': 'nope' }, payload: { result: result() } });
  assert.equal(wrong.statusCode, 401);
  // the browser routes need no secret
  assert.equal((await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: goodBody })).statusCode, 200);
  await a.close();
});

test('worker flow: next -> invalid result 400 -> valid result ok -> browser sees done; a second result is 409', async () => {
  const { a } = await setup();
  const empty = await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/next', headers: secret(), payload: { worker: 'w1' } });
  assert.deepEqual(empty.json(), { check: null });

  const { id } = (await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: goodBody })).json() as { id: string };
  const next = await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/next', headers: secret(), payload: { worker: 'w1' } });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().check.id, id);
  assert.deepEqual(next.json().check.request, goodBody);

  const running = (await a.inject({ method: 'GET', url: `/api/providers/vertex/check/${id}` })).json();
  assert.equal(running.state, 'running');
  assert.equal(running.worker, 'w1');

  const bad = await a.inject({ method: 'POST', url: `/api/agent-checks/vertex/${id}`, headers: secret(), payload: { worker: 'w1', result: { ok: 'yes' } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_request');
  const missing = await a.inject({ method: 'POST', url: `/api/agent-checks/vertex/${id}`, headers: secret(), payload: { worker: 'w1' } });
  assert.equal(missing.statusCode, 400);

  const good = await a.inject({ method: 'POST', url: `/api/agent-checks/vertex/${id}`, headers: secret(), payload: { worker: 'w1', result: result() } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json(), { ok: true });

  const done = (await a.inject({ method: 'GET', url: `/api/providers/vertex/check/${id}` })).json();
  assert.equal(done.state, 'done');
  assert.equal(done.result.ok, true);
  assert.equal(done.result.worker, 'w1');

  const again = await a.inject({ method: 'POST', url: `/api/agent-checks/vertex/${id}`, headers: secret(), payload: { worker: 'w1', result: result() } });
  assert.equal(again.statusCode, 409);
  await a.close();
});

test('a result for an unknown check is 409; next without a worker name is recorded as "unknown"', async () => {
  const { a } = await setup();
  const unknown = await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/does-not-exist', headers: secret(), payload: { worker: 'w1', result: result() } });
  assert.equal(unknown.statusCode, 409);
  assert.equal(unknown.json().error, 'not_running');

  const { id } = (await a.inject({ method: 'POST', url: '/api/providers/vertex/check', payload: goodBody })).json() as { id: string };
  await a.inject({ method: 'POST', url: '/api/agent-checks/vertex/next', headers: secret(), payload: {} });
  assert.equal((await a.inject({ method: 'GET', url: `/api/providers/vertex/check/${id}` })).json().worker, 'unknown');
  await a.close();
});
