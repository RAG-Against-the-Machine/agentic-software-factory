import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UpdateStatus } from '@asf/shared';
import { bannerVisible, checkedAgo, dismissKey, onUpdateStatus, publishUpdateStatus, readDismissed, restartDone, versionLabel, writeDismissed, type KeyValueStore } from './updates-view';

const st = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: 'v1.2.0', latest: 'v1.3.0', available: true, checkedAt: null, error: null, canApply: false, ...over,
});

test('versionLabel normalises a missing v and keeps dev', () => {
  assert.equal(versionLabel('v1.2.0', 'v1.3.0'), 'v1.2.0 → v1.3.0');
  assert.equal(versionLabel('1.2.0', '1.3.0'), 'v1.2.0 → v1.3.0');
  assert.equal(versionLabel('dev', 'v1.3.0'), 'dev → v1.3.0');
  assert.equal(versionLabel('dev', null), 'dev');
});

test('bannerVisible follows available', () => {
  assert.equal(bannerVisible(st(), null), true);
  assert.equal(bannerVisible(st({ available: false }), null), false);
  assert.equal(bannerVisible(st({ latest: null }), null), false);
  assert.equal(bannerVisible(null, null), false);
});

test('bannerVisible hides a dismissed version and shows again for a newer one', () => {
  assert.equal(bannerVisible(st(), 'v1.3.0'), false);
  assert.equal(bannerVisible(st(), '1.3.0'), false);
  assert.equal(bannerVisible(st({ latest: 'v1.4.0' }), 'v1.3.0'), true);
});

test('dismissal round-trips through the injected storage and survives a throwing one', () => {
  const m = new Map<string, string>();
  const store: KeyValueStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
  assert.equal(readDismissed(store), null);
  writeDismissed(store, 'v1.3.0');
  assert.equal(m.get(dismissKey), 'v1.3.0');
  assert.equal(readDismissed(store), 'v1.3.0');
  const broken: KeyValueStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readDismissed(broken), null);
  assert.doesNotThrow(() => writeDismissed(broken, 'v1.3.0'));
  assert.equal(readDismissed(null), null);
  assert.equal(readDismissed(undefined), null);
  assert.doesNotThrow(() => writeDismissed(null, 'v1.3.0'));
});

test('restartDone once current changes', () => {
  assert.equal(restartDone('v1.2.0', st()), false);
  assert.equal(restartDone('v1.2.0', st({ current: '1.2.0' })), false);
  assert.equal(restartDone('v1.2.0', st({ current: 'v1.3.0' })), true);
  assert.equal(restartDone('v1.2.0', null), false);
});

test('checkedAgo', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(checkedAgo(null, now), 'never');
  assert.equal(checkedAgo('nope', now), 'never');
  assert.equal(checkedAgo('2026-10-05T11:59:30Z', now), 'just now');
  assert.equal(checkedAgo('2026-10-05T11:55:00Z', now), '5 min ago');
  assert.equal(checkedAgo('2026-10-05T09:00:00Z', now), '3 h ago');
  assert.equal(checkedAgo('2026-10-04T12:00:00Z', now), '1 day ago');
  assert.equal(checkedAgo('2026-10-02T12:00:00Z', now), '3 days ago');
});

test('publishUpdateStatus reaches subscribers until they unsubscribe', () => {
  const target = new EventTarget();
  const got: UpdateStatus[] = [];
  const off = onUpdateStatus(target, (s) => got.push(s));
  publishUpdateStatus(target, st());
  assert.deepEqual(got, [st()]);
  off();
  publishUpdateStatus(target, st({ available: false }));
  assert.equal(got.length, 1);
});
