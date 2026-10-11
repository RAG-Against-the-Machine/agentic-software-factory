import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from './client.js';

// A 401 from the registry means the shared X-Run-Secret differs between processes;
// the api's error must name that cause so a first-run operator can fix it.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const reply = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
};

test('a 401 from the registry names the RUN_EVENT_SECRET mismatch', async () => {
  reply(401, { ok: false, error: 'unauthorized' });
  await assert.rejects(registry.getRun('run_1'), /failed: 401 .*RUN_EVENT_SECRET mismatch: set the same value in \.env for registry, api and worker and restart all three/);
});

test('non-401 failures carry no secret hint', async () => {
  reply(500, { ok: false, error: 'boom' });
  await assert.rejects(registry.getRun('run_1'), (e: Error) => /failed: 500 boom/.test(e.message) && !/RUN_EVENT_SECRET/.test(e.message));
});
