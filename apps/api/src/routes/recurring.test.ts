import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRecurringRoutes } from './recurring.js';
import { MockScmProvider } from '../providers/scm/mock.js';

// Recurring tasks live in the registry, reached over HTTP via registry/client.ts,
// so global fetch is stubbed with a tiny in-memory registry.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const TASK = {
  id: 'rec_1', title: 'Bump dependencies', body: 'Run the updater.', repoId: '1',
  schedule: { kind: 'weekly', weekdays: [1], time: '09:00' }, timezone: 'Europe/London', paused: false,
  nextRunAt: '2026-10-05T08:00:00.000Z', lastRun: null, createdBy: 'ana', createdAt: '2026-10-01T00:00:00.000Z',
};
const INPUT = { title: 'Bump dependencies', body: 'Run the updater.', repoId: '1', schedule: { kind: 'weekly', weekdays: [1], time: '09:00' }, timezone: 'Europe/London' };

function stubRegistry(calls: { op: string; [k: string]: unknown }[] = []) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; [k: string]: unknown };
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'listRecurring': return ok({ tasks: [TASK] });
      case 'getRecurring': return ok({ task: body.id === TASK.id ? TASK : null });
      case 'createRecurring': return ok({ task: TASK });
      case 'updateRecurring': return ok({ task: { ...TASK, ...(body.patch as object) } });
      case 'setRecurringPaused': return ok({ task: { ...TASK, paused: body.paused } });
      case 'deleteRecurring': return ok({ deleted: body.id === TASK.id });
      default: return ok({});
    }
  }) as unknown as typeof fetch;
  return calls;
}

async function app(scm = new MockScmProvider()) {
  const a = Fastify();
  registerRecurringRoutes(a, { scm });
  await a.ready();
  return a;
}

test('GET /api/recurring lists the tasks; GET /:id returns one or 404s', async () => {
  stubRegistry();
  const a = await app();
  const list = await a.inject({ method: 'GET', url: '/api/recurring' });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().tasks, [TASK]);

  const one = await a.inject({ method: 'GET', url: '/api/recurring/rec_1' });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().task.id, TASK.id);

  const missing = await a.inject({ method: 'GET', url: '/api/recurring/rec_missing' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'not_found');
  await a.close();
});

test('POST /api/recurring creates a task with the caller as its author', async () => {
  const calls = stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/recurring', headers: { 'x-operator': 'ana' }, payload: INPUT });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().task.id, TASK.id);
  const sent = calls.find((c) => c.op === 'createRecurring')!;
  assert.equal(sent.by, 'ana');
  assert.equal((sent.input as { title: string }).title, 'Bump dependencies');
  assert.equal((sent.input as { paused: boolean }).paused, false);
  await a.close();
});

test('POST /api/recurring refuses a bad body, a weekly schedule with no weekday, an unknown zone and an unknown repo', async () => {
  const calls = stubRegistry();
  const a = await app();
  const post = (payload: object) => a.inject({ method: 'POST', url: '/api/recurring', payload });

  const blank = await post({ ...INPUT, title: '  ' });
  assert.equal(blank.statusCode, 400);
  assert.equal(blank.json().error, 'bad_request');
  assert.match(blank.json().reason, /^title: /);

  const noDay = await post({ ...INPUT, schedule: { kind: 'weekly', weekdays: [], time: '09:00' } });
  assert.equal(noDay.statusCode, 400);
  assert.match(noDay.json().reason, /schedule\.weekdays: Pick at least one weekday/);

  const zone = await post({ ...INPUT, timezone: 'Mars/Olympus_Mons' });
  assert.equal(zone.statusCode, 400);
  assert.equal(zone.json().error, 'bad_timezone');
  assert.match(zone.json().reason, /Mars\/Olympus_Mons/);

  const repo = await post({ ...INPUT, repoId: '99' });
  assert.equal(repo.statusCode, 400);
  assert.equal(repo.json().error, 'repo_not_found');
  assert.match(repo.json().reason, /example\/app/);

  assert.equal(calls.filter((c) => c.op === 'createRecurring').length, 0, 'nothing refused reaches the registry');
  await a.close();
});

test('POST /api/recurring refuses any repo when source control has none', async () => {
  stubRegistry();
  const a = await app(new MockScmProvider(''));
  const res = await a.inject({ method: 'POST', url: '/api/recurring', payload: INPUT });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'repo_not_found');
  await a.close();
});

test('PATCH /api/recurring/:id updates only what was sent, checks the zone and repo, and 404s', async () => {
  const calls = stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'PATCH', url: '/api/recurring/rec_1', payload: { schedule: { kind: 'daily', time: '07:30' } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().task.schedule, { kind: 'daily', time: '07:30' });
  assert.deepEqual(calls.find((c) => c.op === 'updateRecurring')!.patch, { schedule: { kind: 'daily', time: '07:30' } });

  assert.equal((await a.inject({ method: 'PATCH', url: '/api/recurring/rec_1', payload: { timezone: 'Nowhere/Land' } })).json().error, 'bad_timezone');
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/recurring/rec_1', payload: { repoId: '99' } })).json().error, 'repo_not_found');
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/recurring/rec_1', payload: { schedule: { kind: 'weekly', weekdays: [], time: '09:00' } } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'PATCH', url: '/api/recurring/rec_missing', payload: { title: 'x' } })).statusCode, 404);
  assert.equal(calls.filter((c) => c.op === 'updateRecurring').length, 1);
  await a.close();
});

test('POST /:id/pause and /:id/resume set the paused flag, and 404 an unknown task', async () => {
  const calls = stubRegistry();
  const a = await app();
  const paused = await a.inject({ method: 'POST', url: '/api/recurring/rec_1/pause' });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().task.paused, true);
  const resumed = await a.inject({ method: 'POST', url: '/api/recurring/rec_1/resume' });
  assert.equal(resumed.json().task.paused, false);
  assert.deepEqual(calls.filter((c) => c.op === 'setRecurringPaused').map((c) => c.paused), [true, false]);

  assert.equal((await a.inject({ method: 'POST', url: '/api/recurring/rec_missing/pause' })).statusCode, 404);
  await a.close();
});

test('DELETE /api/recurring/:id removes a task, then 404s', async () => {
  const calls = stubRegistry();
  const a = await app();
  const del = await a.inject({ method: 'DELETE', url: '/api/recurring/rec_1' });
  assert.equal(del.statusCode, 204);
  assert.equal(calls.find((c) => c.op === 'deleteRecurring')!.id, 'rec_1');
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/recurring/rec_missing' })).statusCode, 404);
  await a.close();
});
