import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeStatus } from '@asf/shared';
import { heartbeat, listFleet, monthUnpricedRuns, registerWorker } from './workers.js';
import { createRun } from './store.js';
import { dbAvailable, testDb, runInput } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('fleet'); });
after(async () => { if (db) await db.close(); });

const at = new Date().toISOString();
const claude: RuntimeStatus = { kind: 'claude-code', installed: true, version: '2.1.0', ok: true, checkedAt: at };
const codexNoKey: RuntimeStatus = { kind: 'codex', installed: true, version: '0.5.0', ok: false, reason: 'no OpenAI key', checkedAt: at };

const fleetWorker = async (id: string) => (await listFleet(db.sql, 60)).workers.find((w) => w.id === id)!;

test('runtime status persists on register and is replaced by a heartbeat that carries it (#69)', { skip }, async () => {
  await registerWorker(db.sql, { id: 'p1', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [], preflight: [claude, codexNoKey] });
  assert.deepEqual((await fleetWorker('p1')).preflight, [claude, codexNoKey]);

  const codexOk: RuntimeStatus = { kind: 'codex', installed: true, version: '0.5.0', ok: true, checkedAt: at };
  assert.equal(await heartbeat(db.sql, 'p1', [claude, codexOk]), true);
  assert.deepEqual((await fleetWorker('p1')).preflight, [claude, codexOk]);

  // A bare heartbeat keeps what was reported last.
  assert.equal(await heartbeat(db.sql, 'p1'), true);
  assert.deepEqual((await fleetWorker('p1')).preflight, [claude, codexOk]);
});

test('a worker that never reported runtime status reads back as an empty list', { skip }, async () => {
  await registerWorker(db.sql, { id: 'p2', host: 'h', runtimes: ['claude-code'], maxConcurrent: 1, inFlightTaskIds: [] });
  assert.deepEqual((await fleetWorker('p2')).preflight, []);
  // A row written before the column existed gets the column default.
  await db.sql`INSERT INTO worker (id, host, runtimes, max_concurrent, registered_at, last_heartbeat)
    VALUES ('p3', 'h', ${db.sql.json(['claude-code'])}, 1, now(), now())`;
  assert.deepEqual((await fleetWorker('p3')).preflight, []);
});

test('unpriced runs this month: a run with a finished $0 agent task, not publish, not a failed/skipped one (M8 WP H)', { skip }, async () => {
  const run = async (key: string) => (await createRun(db.sql, runInput({ ticketId: key, ticketKey: key }))).run.id;
  const finish = (runId: string, seq: number, state: string, cost: number, runtime = 'claude-code') => db.sql`
    UPDATE run_task SET state = ${state}, cost_usd = ${cost}, runtime = ${runtime}, finished_at = now() WHERE run_id = ${runId} AND seq = ${seq}`;
  const before = await monthUnpricedRuns(db.sql);
  const planBilled = await run('U-1');
  await finish(planBilled, 0, 'done', 0, 'copilot');
  await finish(planBilled, 1, 'done', 0, 'copilot');
  const priced = await run('U-2');
  await finish(priced, 0, 'done', 0.25);
  const neverRan = await run('U-3');
  await finish(neverRan, 0, 'failed', 0);
  await finish(neverRan, 1, 'skipped', 0);
  await finish(neverRan, 2, 'done', 0, 'publish');
  assert.equal(await monthUnpricedRuns(db.sql), before + 1, 'counted once per run, however many unpriced tasks it had');
});
