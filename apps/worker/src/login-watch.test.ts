import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VertexCheckCode } from '@asf/shared';
import { googleLoginFix } from '@asf/shared';
import { LoginWatch, NO_LOGIN_RECHECK_MS, type LoginCheck } from './login-watch.js';

const INTERVAL = 300_000;

type Health = { ok: boolean; reason: string | null; fix?: string };

function harness(opts: { recordFails?: boolean } = {}) {
  let t = 1_000_000;
  let next: Awaited<ReturnType<LoginCheck>> = { ok: true };
  let queue: Array<Awaited<ReturnType<LoginCheck>>> = [];
  let checks = 0;
  const sleeps: number[] = [];
  const suspends: string[] = [];
  let resumes = 0;
  const records: Health[] = [];
  const logs: string[] = [];
  let gate: Promise<void> | null = null;
  const watch = new LoginWatch({
    check: async () => { checks++; if (gate) await gate; return queue.shift() ?? next; },
    suspend: (reason) => { suspends.push(reason); },
    resume: () => { resumes++; },
    record: async (h) => { records.push(h); if (opts.recordFails) throw new Error('registry down'); },
    log: (m) => { logs.push(m); },
    sleep: async (ms) => { sleeps.push(ms); },
    worker: 'w1', intervalMs: INTERVAL, now: () => t,
  });
  return {
    watch, suspends, records, logs, sleeps,
    get checks() { return checks; },
    get resumes() { return resumes; },
    advance: (ms: number) => { t += ms; },
    set: (r: Awaited<ReturnType<LoginCheck>>) => { next = r; },
    /** The next checks answer these in order, then fall back to set(). */
    seq: (...r: Array<Awaited<ReturnType<LoginCheck>>>) => { queue = r; },
    hold: () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return () => { gate = null; release(); }; },
  };
}
const gone = (code: VertexCheckCode = 'login_expired', kind?: string): Awaited<ReturnType<LoginCheck>> => ({ ok: false, code, reason: 'refresh failed', ...(kind ? { kind } : {}) });
const shortOf = (what: string) => `Claude on Google Cloud stopped working on worker w1: ${what}.`;

test('not vertex mode: never checks, whatever the mode is', async () => {
  const h = harness();
  for (const mode of ['api-key', 'oauth-token', null]) assert.equal(await h.watch.tick(mode), false);
  assert.equal(h.checks, 0);
  assert.equal(h.records.length, 0);
});

test('vertex and due: checks; healthy login records nothing and changes nothing', async () => {
  const h = harness();
  assert.equal(await h.watch.tick('vertex'), false);
  assert.equal(h.checks, 1);
  assert.deepEqual(h.records, [], 'ok without a prior expiry is not recorded');
  assert.equal(h.suspends.length, 0);
  assert.equal(h.resumes, 0);
  assert.equal(h.watch.isExpired, false);
});

test('not due within intervalMs: no check; due again once the interval has passed', async () => {
  const h = harness();
  await h.watch.tick('vertex');
  h.advance(INTERVAL - 1);
  await h.watch.tick('vertex');
  assert.equal(h.checks, 1, 'still inside the interval');
  h.advance(1);
  await h.watch.tick('vertex');
  assert.equal(h.checks, 2);
});

test('login_expired: suspends with short + fix, records the short reason and the fix apart, returns true only the first time', async () => {
  const h = harness();
  h.set(gone('login_expired'));
  assert.equal(await h.watch.tick('vertex'), true, 'the offered set changed');
  assert.equal(h.watch.isExpired, true);
  const short = shortOf('Google says the login has expired or was revoked');
  const fix = googleLoginFix('w1');
  assert.deepEqual(h.suspends, [`${short} ${fix}`]);
  assert.equal(h.watch.reason, `${short} ${fix}`, 'reason getter is what /health shows');
  assert.equal(h.records.length, 1);
  assert.deepEqual(h.records[0], { ok: false, reason: short, fix });
  assert.ok(!h.records[0].reason!.includes(fix), 'the recorded reason excludes the fix');

  // Still expired on the next check: the hold is re-asserted, but health is NOT re-recorded (same short reason).
  h.advance(INTERVAL);
  assert.equal(await h.watch.tick('vertex'), false);
  assert.equal(h.suspends.length, 2, 'still re-suspends');
  assert.equal(h.records.length, 1, 'record only when the short reason changes');
  assert.equal(h.resumes, 0);
});

test('the fix follows the credential kind (service account vs gcloud login)', async () => {
  const h = harness();
  h.set(gone('login_expired', 'service_account'));
  await h.watch.tick('vertex');
  assert.equal(h.records[0].fix, googleLoginFix('w1', 'service_account'));
  assert.notEqual(h.records[0].fix, googleLoginFix('w1'));
  assert.ok(h.suspends[0].endsWith(googleLoginFix('w1', 'service_account')));
});

test('a changed short reason is recorded again (no_login -> login_expired); an unchanged one is not', async () => {
  const h = harness();
  h.set(gone('login_expired'));
  await h.watch.tick('vertex');
  h.set(gone('no_login'));
  h.advance(INTERVAL);
  await h.watch.tick('vertex');
  assert.equal(h.records.length, 2);
  assert.equal(h.records[1].reason, shortOf('no Google login was found'));
  assert.equal(h.records[1].ok, false);
  h.advance(INTERVAL);
  await h.watch.tick('vertex');
  assert.equal(h.records.length, 2, 'same short reason again: quiet');
});

test('a record that failed is retried on the next tick (the short reason is only remembered once recorded)', async () => {
  const h = harness({ recordFails: true });
  h.set(gone());
  await h.watch.tick('vertex');
  h.advance(INTERVAL);
  await h.watch.tick('vertex');
  assert.equal(h.records.length, 2, 'tried again because the first never landed');
});

test('no_login: re-read once after the pause; suspends only if the second read is also no_login', async () => {
  const h = harness();
  h.set(gone('no_login'));
  assert.equal(await h.watch.tick('vertex'), true);
  assert.equal(h.checks, 2, 'read twice');
  assert.deepEqual(h.sleeps, [NO_LOGIN_RECHECK_MS]);
  assert.match(h.suspends[0], /no Google login was found/);
  assert.equal(h.records[0].ok, false);
  assert.equal(h.records[0].reason, shortOf('no Google login was found'));
});

test('no_login then ok on the re-read (a file mid-rewrite): nothing happens', async () => {
  const h = harness();
  h.seq(gone('no_login'), { ok: true });
  assert.equal(await h.watch.tick('vertex'), false);
  assert.equal(h.checks, 2);
  assert.deepEqual(h.sleeps, [NO_LOGIN_RECHECK_MS]);
  assert.equal(h.suspends.length, 0);
  assert.equal(h.records.length, 0);
  assert.equal(h.resumes, 0);
  assert.equal(h.watch.isExpired, false);
});

test('no_login then login_expired on the re-read: judged on the second read', async () => {
  const h = harness();
  h.seq(gone('no_login'), gone('login_expired'));
  assert.equal(await h.watch.tick('vertex'), true);
  assert.match(h.suspends[0], /expired or was revoked/);
});

test('login_expired is not re-read: one check, no pause', async () => {
  const h = harness();
  h.set(gone('login_expired'));
  await h.watch.tick('vertex');
  assert.equal(h.checks, 1);
  assert.deepEqual(h.sleeps, []);
});

test('unsupported_login: logged once with the kind; no suspend, no record, no change, however many ticks', async () => {
  const h = harness();
  h.set(gone('unsupported_login', 'external_account'));
  for (let i = 0; i < 3; i++) {
    assert.equal(await h.watch.tick('vertex'), false);
    h.advance(INTERVAL);
  }
  assert.equal(h.checks, 3);
  assert.equal(h.suspends.length, 0);
  assert.equal(h.records.length, 0);
  assert.equal(h.resumes, 0);
  assert.equal(h.watch.isExpired, false);
  const lines = h.logs.filter((l) => l.includes('external_account'));
  assert.equal(lines.length, 1, 'said once');
  assert.deepEqual(h.sleeps, [], 'no re-read for it');
});

test('poke() forces an immediate check inside the interval', async () => {
  const h = harness();
  await h.watch.tick('vertex');
  h.advance(1000);
  await h.watch.tick('vertex');
  assert.equal(h.checks, 1);
  h.set(gone());
  h.watch.poke();
  assert.equal(await h.watch.tick('vertex'), true);
  assert.equal(h.checks, 2);
});

test('inconclusive codes (unreachable / other / permission) change nothing and return false', async () => {
  for (const code of ['unreachable', 'other', 'no_permission'] as VertexCheckCode[]) {
    const h = harness();
    h.set(gone(code));
    assert.equal(await h.watch.tick('vertex'), false, code);
    assert.equal(h.suspends.length, 0, code);
    assert.equal(h.records.length, 0, code);
    assert.equal(h.resumes, 0, code);
    assert.equal(h.watch.isExpired, false, code);
    assert.ok(h.logs.some((l) => l.includes(code)), `logged ${code}`);
  }
});

test('an inconclusive check while expired keeps the expiry (a network blip is not a recovery)', async () => {
  const h = harness();
  h.set(gone());
  await h.watch.tick('vertex');
  h.set(gone('unreachable'));
  h.advance(INTERVAL);
  assert.equal(await h.watch.tick('vertex'), false);
  assert.equal(h.watch.isExpired, true);
  assert.equal(h.resumes, 0);
  assert.equal(h.records.length, 1);
});

test('recovery after expiry: resumes, records ok, returns true; later ok checks are silent', async () => {
  const h = harness();
  h.set(gone());
  await h.watch.tick('vertex');
  h.set({ ok: true, account: 'ada@example.com' });
  h.advance(INTERVAL);
  assert.equal(await h.watch.tick('vertex'), true);
  assert.equal(h.resumes, 1);
  assert.deepEqual(h.records.at(-1), { ok: true, reason: null });
  assert.equal(h.watch.isExpired, false);
  assert.ok(h.logs.some((l) => /works again/.test(l)));

  const recordsBefore = h.records.length;
  h.advance(INTERVAL);
  assert.equal(await h.watch.tick('vertex'), false);
  assert.equal(h.records.length, recordsBefore, 'ok without a prior expiry is not recorded');
  assert.equal(h.resumes, 1);
});

test('a second expiry after recovery is a fresh streak (returns true again)', async () => {
  const h = harness();
  h.set(gone()); await h.watch.tick('vertex');
  h.set({ ok: true }); h.advance(INTERVAL); await h.watch.tick('vertex');
  h.set(gone()); h.advance(INTERVAL);
  assert.equal(await h.watch.tick('vertex'), true);
  assert.deepEqual(h.records.map((r) => r.ok), [false, true, false]);
});

test('switching off vertex while expired: resumes and returns true; afterwards quiet', async () => {
  const h = harness();
  h.set(gone());
  await h.watch.tick('vertex');
  assert.equal(await h.watch.tick('api-key'), true);
  assert.equal(h.resumes, 1);
  assert.deepEqual(h.records.at(-1), { ok: true, reason: null }, 'health cleared too');
  assert.equal(h.watch.isExpired, false);
  assert.equal(h.watch.reason, null);
  assert.equal(await h.watch.tick('api-key'), false, 'only the first tick off vertex reports a change');
  assert.equal(h.resumes, 1);
});

test('mode null (api unreachable) while expired: no change', async () => {
  const h = harness();
  h.set(gone());
  await h.watch.tick('vertex');
  assert.equal(await h.watch.tick(null), false);
  assert.equal(h.resumes, 0);
  assert.equal(h.watch.isExpired, true);
});

test('overlapping ticks do not double-check', async () => {
  const h = harness();
  const release = h.hold();
  const first = h.watch.tick('vertex');
  h.watch.poke(); // would be due again, but a check is already in flight
  const second = await h.watch.tick('vertex');
  assert.equal(second, false);
  assert.equal(h.checks, 1);
  release();
  await first;
  assert.equal(h.checks, 1);
  // The guard is released afterwards: a poke makes the next tick check again.
  h.watch.poke();
  await h.watch.tick('vertex');
  assert.equal(h.checks, 2);
});

test('a throwing check does not leave the watch stuck "running"', async () => {
  let n = 0;
  const w = new LoginWatch({
    check: async () => { n++; if (n === 1) throw new Error('boom'); return { ok: true }; },
    suspend: () => {}, resume: () => {}, record: async () => {}, log: () => {}, worker: 'w1', intervalMs: 0,
  });
  await assert.rejects(() => w.tick('vertex'), /boom/);
  assert.equal(await w.tick('vertex'), false);
  assert.equal(n, 2);
});

test('record rejecting does not throw, on expiry or on recovery', async () => {
  const h = harness({ recordFails: true });
  h.set(gone());
  assert.equal(await h.watch.tick('vertex'), true);
  assert.equal(h.suspends.length, 1, 'still suspended');
  assert.ok(h.logs.some((l) => /could not record login health/.test(l)));
  h.set({ ok: true });
  h.advance(INTERVAL);
  assert.equal(await h.watch.tick('vertex'), true);
  assert.equal(h.resumes, 1);
});

test('confirm(): runs a check now (ignoring the interval) and is true only when the login is gone', async () => {
  const h = harness();
  await h.watch.tick('vertex'); // checked just now; inside the interval
  h.set(gone('login_expired'));
  assert.equal(await h.watch.confirm(), true);
  assert.equal(h.checks, 2, 'a fresh check despite the interval');
  assert.equal(h.watch.isExpired, true);
  assert.equal(h.suspends.length, 1, 'the worker stops claiming at once');
  assert.equal(h.records.length, 1);
});

test('confirm() with a healthy login is false and changes nothing', async () => {
  const h = harness();
  assert.equal(await h.watch.confirm(), false);
  assert.equal(h.suspends.length, 0);
  assert.equal(h.records.length, 0);
});

test('confirm() with an inconclusive check (network) is false', async () => {
  const h = harness();
  h.set(gone('unreachable'));
  assert.equal(await h.watch.confirm(), false);
  assert.equal(h.watch.isExpired, false);
});

test('confirm() while a check is in flight awaits it instead of starting another', async () => {
  const h = harness();
  const release = h.hold();
  const ticking = h.watch.tick('vertex');
  h.set(gone('login_expired'));
  const confirming = h.watch.confirm();
  release();
  assert.equal(await confirming, true);
  await ticking;
  assert.equal(h.checks, 1, 'one check served both');
});

test('confirm() while already expired and still gone stays true; once recovered it is false', async () => {
  const h = harness();
  h.set(gone());
  await h.watch.tick('vertex');
  assert.equal(await h.watch.confirm(), true);
  h.set({ ok: true });
  assert.equal(await h.watch.confirm(), false);
  assert.equal(h.resumes, 1);
});

test('reason getter: null while healthy, short + fix while expired, null again after recovery', async () => {
  const h = harness();
  assert.equal(h.watch.reason, null);
  h.set(gone());
  await h.watch.tick('vertex');
  assert.equal(h.watch.reason, `${shortOf('Google says the login has expired or was revoked')} ${googleLoginFix('w1')}`);
  h.set({ ok: true });
  h.advance(INTERVAL);
  await h.watch.tick('vertex');
  assert.equal(h.watch.reason, null);
});
