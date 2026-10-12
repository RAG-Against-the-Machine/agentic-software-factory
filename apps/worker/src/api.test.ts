import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.js';

// A 401 from the registry or api means the shared X-Run-Secret differs between
// processes. The worker's error must name that cause so a first-run operator can fix it.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const reply = (status: number, body: unknown = {}) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
};

test('a 401 on a registry POST names the RUN_EVENT_SECRET mismatch', async () => {
  reply(401, { error: 'unauthorized' });
  await assert.rejects(api.claim(['claude']), /-> 401 .*RUN_EVENT_SECRET mismatch: set the same value in \.env for registry, api and worker and restart all three/);
});

test('a 401 on the api run-context fetch names the RUN_EVENT_SECRET mismatch', async () => {
  reply(401);
  await assert.rejects(api.context('run_1'), /context run_1 -> 401.*RUN_EVENT_SECRET mismatch/);
});

test('non-401 failures carry no secret hint', async () => {
  reply(500, { error: 'boom' });
  await assert.rejects(api.claim(['claude']), (e: Error) => /-> 500/.test(e.message) && !/RUN_EVENT_SECRET/.test(e.message));
  reply(404);
  await assert.rejects(api.context('run_1'), (e: Error) => /-> 404/.test(e.message) && !/RUN_EVENT_SECRET/.test(e.message));
});

test('a heartbeat carries the runtime status to the registry (#69)', async () => {
  let sent: unknown = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response('{}', { status: 200 }); }) as typeof fetch;
  const preflight = [{ kind: 'codex', installed: true, version: '0.5.0', ok: false, reason: 'no key', checkedAt: '2026-01-01T00:00:00.000Z' }];
  assert.equal(await api.heartbeat(preflight), 'ok');
  assert.deepEqual(sent, { preflight });
});

test('a heartbeat answers \'unknown\' on 404 (registry lost the worker), \'error\' on other failures and on a network throw', async () => {
  reply(404, { error: 'unknown worker' });
  assert.equal(await api.heartbeat(), 'unknown');
  reply(500, { error: 'boom' });
  assert.equal(await api.heartbeat(), 'error');
  reply(401);
  assert.equal(await api.heartbeat(), 'error', 'a non-404 refusal is not \'unknown\'');
  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  assert.equal(await api.heartbeat(), 'error');
});

test('listAdhoc returns the registry\'s tasks, or [] on an older registry / transport error', async () => {
  reply(200, { result: { tasks: [{ key: 'ADHOC-1', title: 'Thing' }] } });
  assert.deepEqual(await api.listAdhoc(), [{ key: 'ADHOC-1', title: 'Thing' }]);

  reply(200, {});
  assert.deepEqual(await api.listAdhoc(), []);

  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  assert.deepEqual(await api.listAdhoc(), []);
});

test('createAdhoc returns the registry\'s task, or null on an older registry / transport error', async () => {
  let sent: unknown = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ result: { task: { key: 'ADHOC-2', title: 'New thing' } } }), { status: 200 });
  }) as typeof fetch;
  const input = { title: 'New thing', body: '', createdBy: 'agent:implementer', attachments: [] };
  assert.deepEqual(await api.createAdhoc(input), { key: 'ADHOC-2', title: 'New thing' });
  assert.deepEqual(sent, { op: 'createAdhoc', input });

  reply(200, {});
  assert.equal(await api.createAdhoc(input), null);

  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  assert.equal(await api.createAdhoc(input), null);
});
