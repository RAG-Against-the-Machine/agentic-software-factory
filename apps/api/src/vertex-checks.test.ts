import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VertexCheckResult } from '@asf/shared';
import { VertexChecks, QUEUE_TIMEOUT_MS, RUN_TIMEOUT_MS } from './vertex-checks.js';

const req = { projectId: 'my-proj', region: 'global', models: ['claude-sonnet-5'] };
const okResult = (): VertexCheckResult => ({
  ok: true, login: { ok: true, account: 'me@example.com' },
  models: [{ id: 'claude-sonnet-5', tier: 'balanced', ok: true }],
  claudeCode: { ok: true, model: 'claude-sonnet-5' }, checkedAt: '2026-01-01T00:00:00.000Z',
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('create -> get is queued, with a since timestamp and no worker', () => {
  const c = clock(); const checks = new VertexChecks(c.now);
  const id = checks.create(req);
  assert.deepEqual(checks.get(id), { id, state: 'queued', since: new Date(1_000_000).toISOString() });
  assert.equal(checks.get('nope'), null);
});

test('take returns the oldest queued check and marks it running on the worker', () => {
  const c = clock(); const checks = new VertexChecks(c.now);
  const a = checks.create({ ...req, projectId: 'first-proj' });
  c.advance(10);
  const b = checks.create({ ...req, projectId: 'second-proj' });
  const t1 = checks.take('w1');
  assert.equal(t1?.id, a);
  assert.equal(t1?.request.projectId, 'first-proj');
  assert.deepEqual(checks.get(a), { id: a, state: 'running', worker: 'w1', since: new Date(1_000_010).toISOString() });
  assert.equal(checks.get(b)?.state, 'queued');
  assert.equal(checks.take('w2')?.id, b);
  assert.equal(checks.take('w3'), null, 'both are taken');
});

test('take when nothing is queued is null', () => {
  assert.equal(new VertexChecks(clock().now).take('w'), null);
});

test('finish -> get is done, with the finishing worker stamped on the result', () => {
  const checks = new VertexChecks(clock().now);
  const id = checks.create(req);
  checks.take('w1');
  assert.equal(checks.finish(id, 'w1', okResult()), true);
  const s = checks.get(id);
  assert.equal(s?.state, 'done');
  assert.equal(s?.state === 'done' && s.result.worker, 'w1');
  assert.equal(s?.state === 'done' && s.result.ok, true);
});

test('finish twice, or for an unknown id, is false and keeps the first result', () => {
  const checks = new VertexChecks(clock().now);
  const id = checks.create(req);
  checks.take('w1');
  assert.equal(checks.finish(id, 'w1', okResult()), true);
  assert.equal(checks.finish(id, 'w2', { ...okResult(), ok: false }), false);
  const s = checks.get(id);
  assert.ok(s?.state === 'done' && s.result.ok && s.result.worker === 'w1');
  assert.equal(checks.finish('missing', 'w1', okResult()), false);
});

test('a check nobody takes within QUEUE_TIMEOUT_MS becomes done with login code no_worker', () => {
  const c = clock(); const checks = new VertexChecks(c.now);
  const id = checks.create(req);
  c.advance(QUEUE_TIMEOUT_MS);
  assert.equal(checks.get(id)?.state, 'queued', 'exactly at the limit is still waiting');
  c.advance(1);
  const s = checks.get(id);
  assert.ok(s?.state === 'done');
  assert.equal(s.result.ok, false);
  assert.equal(s.result.login.code, 'no_worker');
  assert.equal(s.result.claudeCode.skipped, true);
  assert.equal(checks.take('late-worker'), null, 'a timed-out check is no longer takeable');
});

test('a running check that never answers within RUN_TIMEOUT_MS becomes done with code other, naming the worker', () => {
  const c = clock(); const checks = new VertexChecks(c.now);
  const id = checks.create(req);
  checks.take('w-crashed');
  c.advance(RUN_TIMEOUT_MS);
  assert.equal(checks.get(id)?.state, 'running');
  c.advance(1);
  const s = checks.get(id);
  assert.ok(s?.state === 'done');
  assert.equal(s.result.login.code, 'other');
  assert.match(s.result.login.reason ?? '', /w-crashed/);
  assert.equal(checks.finish(id, 'w-crashed', okResult()), false, 'a late answer is refused');
});

test('the running timeout counts from when the worker took it, not from creation', () => {
  const c = clock(); const checks = new VertexChecks(c.now);
  const id = checks.create(req);
  c.advance(QUEUE_TIMEOUT_MS - 1_000);
  checks.take('w1');
  c.advance(RUN_TIMEOUT_MS - 1_000);
  assert.equal(checks.get(id)?.state, 'running');
});

test('finished checks are forgotten after a while', () => {
  const c = clock(); const checks = new VertexChecks(c.now);
  const id = checks.create(req);
  checks.take('w'); checks.finish(id, 'w', okResult());
  c.advance(16 * 60_000);
  assert.equal(checks.get(id), null);
});
