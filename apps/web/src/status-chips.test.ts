import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendText, todaySpendUsd, workerSummary } from './status-chips.js';

const worker = (id: string) => ({ id, host: 'h', runtimes: [], authMode: null, maxConcurrent: 2, running: 1, lastHeartbeat: '2026-10-02T08:00:00Z', preflight: [] });

test('no worker reads as a warning', () => {
  assert.deepEqual(workerSummary({ workers: [], capacity: 0, running: 0 }), { online: false, text: 'No worker online' });
});

test('online workers read "n online · busy/capacity busy"', () => {
  assert.deepEqual(workerSummary({ workers: [worker('a'), worker('b')], capacity: 4, running: 2 }), { online: true, text: '2 online · 2/4 busy' });
});

test("today's spend sums running and done-today costs", () => {
  const run = (costUsd: number) => ({ costUsd });
  assert.equal(todaySpendUsd({ running: [run(0.5)], doneToday: [run(1.25), run(0.25)] } as never), 2);
  assert.equal(todaySpendUsd({ running: [], doneToday: [] }), 0);
});

test('spend reads "$X.XX today"', () => {
  assert.equal(spendText(2), '$2.00 today');
  assert.equal(spendText(0.126), '$0.13 today');
});
