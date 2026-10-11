import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { putSetting, deleteSetting, describe } from './settings.js';

/**
 * putSetting routes a secret:true org key to the write-only org_secret sink and
 * stores only the pointer secret://org/<KEY> in org_setting; a non-secret key is
 * stored as-is. We stub global.fetch to capture the registry RPC calls (the api
 * never touches Postgres) and drive the two paths.
 */
type RpcCall = { op: string; [k: string]: unknown };
let calls: RpcCall[] = [];
let orgStore: Record<string, unknown> = {};
const realFetch = global.fetch;

beforeEach(() => {
  calls = [];
  orgStore = {};
  // A fake registry: record every op, mutate an in-memory org_setting map, and
  // answer getOrgSettings from it so loadOrgSettings() reflects the write.
  global.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as RpcCall;
    calls.push(body);
    let result: unknown = { ok: true };
    switch (body.op) {
      case 'putOrgSetting': orgStore[body.key as string] = body.value; break;
      case 'deleteOrgSetting': delete orgStore[body.key as string]; break;
      case 'getOrgSettings': result = { settings: orgStore }; break;
      case 'putOrgSecret': case 'deleteOrgSecret': break;
      default: break;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }) as unknown as typeof fetch;
});
afterEach(() => { global.fetch = realFetch; });

const opsFor = (op: string) => calls.filter((c) => c.op === op);

test('a secret org key stores bytes in the sink and only a pointer in org_setting', async () => {
  await putSetting('JIRA_API_TOKEN', 'tok-xyz', 'jon');

  const [put] = opsFor('putOrgSecret');
  assert.equal(put.name, 'JIRA_API_TOKEN');
  assert.equal(put.value, 'tok-xyz');

  const [setPtr] = opsFor('putOrgSetting');
  assert.equal(setPtr.key, 'JIRA_API_TOKEN');
  assert.equal(setPtr.value, 'secret://org/JIRA_API_TOKEN', 'org_setting holds the pointer, never the token');

  // The raw token is never sent to a plain org_setting.
  assert.ok(!opsFor('putOrgSetting').some((c) => c.value === 'tok-xyz'));

  // describe() redacts the secret to '***' — the browser only learns set/unset.
  const view = describe().find((v) => v.key === 'JIRA_API_TOKEN')!;
  assert.equal(view.orgValue, '***');
  assert.notEqual(view.value, 'tok-xyz');
});

test('an empty secret clears both the sink and the pointer', async () => {
  await putSetting('GITHUB_TOKEN', '', 'jon');
  assert.equal(opsFor('deleteOrgSecret').length, 1);
  assert.equal(opsFor('deleteOrgSecret')[0].name, 'GITHUB_TOKEN');
  assert.equal(opsFor('deleteOrgSetting').length, 1);
  assert.equal(opsFor('putOrgSecret').length, 0);
});

test('deleteSetting on a secret key also drops the paired sink bytes', async () => {
  await deleteSetting('JIRA_API_TOKEN');
  assert.equal(opsFor('deleteOrgSecret').length, 1);
  assert.equal(opsFor('deleteOrgSetting').length, 1);
});

test('a non-secret org key is stored verbatim, no sink write', async () => {
  await putSetting('JIRA_PROJECTS', 'KAN,OPS', 'jon');
  assert.equal(opsFor('putOrgSecret').length, 0);
  const [set] = opsFor('putOrgSetting');
  assert.equal(set.key, 'JIRA_PROJECTS');
  assert.equal(set.value, 'KAN,OPS');
});

test('a deploy-time key is refused before any registry call', async () => {
  await assert.rejects(() => putSetting('DATABASE_URL', 'x', 'jon'), /deploy-time/);
  assert.equal(calls.length, 0);
});

/**
 * loadOrgSettingsWithRetry: at boot the registry may not be listening yet. A
 * one-shot load that fails leaves the api serving an EMPTY org tier (every UI
 * setting silently absent; worker crash-loops on "no credential"). The retry
 * must keep going until the registry answers, with bounded exponential backoff,
 * and the loaded values must then be visible through describe().
 */
test('loadOrgSettingsWithRetry keeps retrying a down registry, then loads the org tier', async () => {
  const { loadOrgSettingsWithRetry, orgSettingsLoaded } = await import('./settings.js');
  let attempts = 0;
  orgStore = { TICKET_PROVIDER: 'trello' };
  global.fetch = (async (_url: string, init: { body: string }) => {
    attempts++;
    if (attempts <= 3) throw new TypeError('fetch failed'); // registry not up yet
    const body = JSON.parse(init.body) as RpcCall;
    return new Response(JSON.stringify({ ok: true, result: body.op === 'getOrgSettings' ? { settings: orgStore } : {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const retries: Array<{ attempt: number; nextDelayMs: number }> = [];
  const slept: number[] = [];
  await loadOrgSettingsWithRetry({
    delayMs: 100, maxDelayMs: 250,
    sleep: async (ms) => { slept.push(ms); },
    onRetry: (attempt, err, nextDelayMs) => { assert.match(err.message, /could not load org settings/); retries.push({ attempt, nextDelayMs }); },
  });

  assert.equal(attempts, 4, 'three failures then one success');
  assert.deepEqual(retries.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(slept, [100, 200, 250], 'exponential backoff, capped at maxDelayMs');
  assert.equal(orgSettingsLoaded(), true);
  const tp = describe().find((s) => s.key === 'TICKET_PROVIDER');
  assert.equal(tp?.orgValue, 'trello', 'the org tier is live once the retry succeeds');
});

/**
 * The worker has no org-settings cache; it gets org-tier worker knobs from the api
 * on every run context (RunContext.workerSettings). Before this, WORKER_MAX_TURNS
 * set to 150 in /admin was accepted and displayed but the worker kept spawning
 * `--max-turns 40` (env > default only) — two real runs failed on the ceiling.
 */
test('computeWorkerSettings reflects an org-tier WORKER_MAX_TURNS / SEGMENT_TIMEOUT_MS write (what the worker receives)', async () => {
  const { computeWorkerSettings } = await import('./routes/runs.js');
  delete process.env.WORKER_MAX_TURNS; delete process.env.SEGMENT_TIMEOUT_MS;
  await putSetting('WORKER_MAX_TURNS', 150, 'jon');
  await putSetting('SEGMENT_TIMEOUT_MS', 60 * 60_000, 'jon');
  const ws = computeWorkerSettings();
  assert.deepEqual({ maxTurns: ws.maxTurns, segmentTimeoutMs: ws.segmentTimeoutMs }, { maxTurns: 150, segmentTimeoutMs: 3_600_000 });
  // env still pins (env > org), matching what the /admin envPinned flag tells the operator.
  process.env.WORKER_MAX_TURNS = '20';
  assert.equal(computeWorkerSettings().maxTurns, 20);
  delete process.env.WORKER_MAX_TURNS;
  await deleteSetting('WORKER_MAX_TURNS'); await deleteSetting('SEGMENT_TIMEOUT_MS');
  assert.equal(computeWorkerSettings().maxTurns, 40, 'catalogue default after the org value is cleared');
});

test('computeWorkerSettings delivers MAX_TURNS_<ROLE> as maxTurnsByRole; 0 drops the entry', async () => {
  const { computeWorkerSettings } = await import('./routes/runs.js');
  delete process.env.WORKER_MAX_TURNS; delete process.env.MAX_TURNS_IMPLEMENTER;
  await putSetting('WORKER_MAX_TURNS', 40, 'jon');
  await putSetting('MAX_TURNS_IMPLEMENTER', 150, 'jon');
  const ws = computeWorkerSettings();
  assert.equal(ws.maxTurns, 40);
  assert.equal(ws.maxTurnsByRole?.implementer, 150);
  await putSetting('MAX_TURNS_IMPLEMENTER', 0, 'jon');
  assert.ok(!('implementer' in (computeWorkerSettings().maxTurnsByRole ?? {})), '0 = fall back to WORKER_MAX_TURNS');
  await deleteSetting('MAX_TURNS_IMPLEMENTER'); await deleteSetting('WORKER_MAX_TURNS');
});
