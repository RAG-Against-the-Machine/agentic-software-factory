import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SplitPartWire, SplitFamilyWire } from '@asf/shared/ui';
import { stripPartSuffix } from '@asf/shared/ui';
import { partStatus, splitProgress } from './split-view.js';

const part = (over: Partial<SplitPartWire> = {}): SplitPartWire => ({
  part: 1, key: 'ADHOC-A', ticketId: 'adhoc:a', title: 'Data model', dependsOn: [], waitingOn: [],
  queueState: 'queued', merged: false, run: null, ...over,
});
const run = (over: Partial<NonNullable<SplitPartWire['run']>> = {}): NonNullable<SplitPartWire['run']> => ({
  id: 'run_1', state: 'running', deliveryOutcome: null, changeRequestUrl: null, changeRequestState: null, costUsd: 1, ...over,
});

test('a queued part names exactly which parts it is waiting on to merge', () => {
  assert.deepEqual(partStatus(part({ waitingOn: ['ADHOC-A', 'ADHOC-B'] })), { label: 'Waiting for ADHOC-A, ADHOC-B to merge', tone: 'waiting' });
  assert.deepEqual(partStatus(part()), { label: 'Up next, starting soon', tone: 'idle' });
});

test('a started part reflects its run, and merged beats everything', () => {
  assert.equal(partStatus(part({ queueState: 'dispatched', run: run() })).label, 'In progress');
  assert.equal(partStatus(part({ queueState: 'dispatched', run: run({ state: 'awaiting_checkpoint' }) })).label, 'Waiting on you');
  assert.equal(partStatus(part({ queueState: 'dispatched', run: run({ state: 'failed' }) })).tone, 'attention');
  assert.equal(partStatus(part({ queueState: 'dispatched', run: run({ state: 'succeeded', deliveryOutcome: 'awaiting_external_merge', changeRequestUrl: 'u', changeRequestState: 'open' }) })).label, 'Pull request ready to merge');
  assert.equal(partStatus(part({ queueState: 'dispatched', run: run({ state: 'succeeded', changeRequestUrl: 'u', changeRequestState: 'closed' }) })).label, 'Pull request closed without merging');
  assert.deepEqual(partStatus(part({ merged: true, run: run({ state: 'succeeded' }) })), { label: 'Merged', tone: 'done' });
});

test('progress line and the stored "(KEY part n/m)" suffix', () => {
  const f: SplitFamilyWire = { parent: { runId: 'r', ticketKey: 'X', title: 't' }, currentPart: null, parts: [part({ merged: true }), part(), part()] };
  assert.equal(splitProgress(f), '1 of 3 merged');
  assert.equal(splitProgress({ ...f, parts: f.parts.map((p) => ({ ...p, merged: true })) }), 'All 3 merged');
  assert.equal(stripPartSuffix('Data model (owner/repo#188 part 1/4)'), 'Data model');
  assert.equal(stripPartSuffix('UI (ADHOC-1 part 4/4)'), 'UI');
  assert.equal(stripPartSuffix('No suffix (here)'), 'No suffix (here)');
});
