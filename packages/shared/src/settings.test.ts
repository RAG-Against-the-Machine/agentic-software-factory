import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, resolveAll, SettingError, orgSettableKeys, renderEnvExample, describeSettings, SETTINGS } from './settings.js';
import { WORKER_ORG_SETTING_KEYS, ROLE_SKILL_ORG_SETTING_KEYS, MAX_TURNS_ORG_SETTING_KEYS } from './context.js';

test('precedence: env > org > default', () => {
  assert.equal(resolve('STALE_AFTER_MIN', {}, {}), 15);
  assert.equal(resolve('STALE_AFTER_MIN', {}, { STALE_AFTER_MIN: 30 }), 30);
  assert.equal(resolve('STALE_AFTER_MIN', { STALE_AFTER_MIN: '45' }, { STALE_AFTER_MIN: 30 }), 45);
});

test('coercion and enum validation, naming the key', () => {
  assert.equal(resolve('WORKER_DRY_RUN', { WORKER_DRY_RUN: 'true' }), true);
  assert.equal(resolve('WORKER_DRY_RUN', { WORKER_DRY_RUN: '0' }), false);
  assert.throws(() => resolve('STALE_AFTER_MIN', { STALE_AFTER_MIN: 'soon' }), (e: unknown) => e instanceof SettingError && /STALE_AFTER_MIN/.test((e as Error).message));
  assert.throws(() => resolve('AGENT_AUTH_MODE', { AGENT_AUTH_MODE: 'magic' }), /oauth-token \| api-key \| vertex \| bedrock/);
});

test('PIPELINE_STAGES is org-only: the environment cannot set it', () => {
  assert.throws(() => resolve('PIPELINE_STAGES', { PIPELINE_STAGES: '{"merge":{"enabled":false}}' }), /org-level setting/);
  assert.deepEqual(resolve('PIPELINE_STAGES', {}, { PIPELINE_STAGES: { merge: { enabled: false, gate: 'required' } } }), { merge: { enabled: false, gate: 'required' } });
});

test('deploy-time keys cannot be set at the org tier', () => {
  assert.throws(() => resolve('DATABASE_URL', {}, { DATABASE_URL: 'postgres://x' }), /deploy-time/);
  assert.ok(!orgSettableKeys().includes('DATABASE_URL'));
  assert.ok(orgSettableKeys().includes('ORG_MAX_COST_USD'));
});

test('resolveAll covers every key and .env.example renders every env-tier key, never a secret value', () => {
  const all = resolveAll({}, {});
  assert.equal(Object.keys(all).length, Object.keys(SETTINGS).length);
  const env = renderEnvExample();
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.tiers.includes('env')) assert.match(env, new RegExp(`^${key}=`, 'm'), `${key} missing from .env.example`);
    else assert.doesNotMatch(env, new RegExp(`^${key}=`, 'm'), `${key} is org-only and must not appear`);
    if (def.secret) assert.match(env, new RegExp(`^${key}=$`, 'm'), `${key} must render blank`);
  }
});

test('renderEnvExample: no non-secret default is scrubbed to *** (the shipped password must work)', () => {
  const env = renderEnvExample();
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (!def.tiers.includes('env') || def.secret) continue;
    const line = env.split('\n').find((l) => l.startsWith(`${key}=`));
    assert.ok(line !== undefined, `${key} missing from .env.example`);
    assert.doesNotMatch(line!, /\*\*\*/, `${key} default is scrubbed to *** — a non-secret key must ship its working default`);
  }
});

test('describeSettings: never leaks a secret value, flags org-settable, and carries the effective value', () => {
  const views = describeSettings({ GITHUB_TOKEN: 'ghp_supersecret' }, { ORG_MAX_COST_USD: 50 });
  const byKey = Object.fromEntries(views.map((v) => [v.key, v]));
  // Secret set in the env: the UI is told it is set (***) but never the value.
  assert.equal(byKey.GITHUB_TOKEN.secret, true);
  assert.equal(byKey.GITHUB_TOKEN.value, '***');
  assert.equal(JSON.stringify(views).includes('ghp_supersecret'), false);
  // Org-settable policy key reflects the org value and is marked editable.
  assert.equal(byKey.ORG_MAX_COST_USD.orgSettable, true);
  assert.equal(byKey.ORG_MAX_COST_USD.value, 50);
  assert.equal(byKey.ORG_MAX_COST_USD.orgValue, 50);
  // A deploy-time key is not org-settable.
  assert.equal(byKey.DATABASE_URL.orgSettable, false);
  // Every catalogue key appears exactly once.
  assert.equal(views.length, Object.keys(SETTINGS).length);
});

test('describeSettings: envPinned flags a key whose non-empty env var overrides the org/UI value', () => {
  // TICKET_PROVIDER pinned in env AND set in org: env wins, and the UI is told so.
  const pinned = Object.fromEntries(describeSettings({ TICKET_PROVIDER: 'mock' }, { TICKET_PROVIDER: 'trello' }).map((v) => [v.key, v]));
  assert.equal(pinned.TICKET_PROVIDER.envPinned, true);
  assert.equal(pinned.TICKET_PROVIDER.value, 'mock', 'env wins over org');
  assert.equal(pinned.TICKET_PROVIDER.orgValue, 'trello');
  // Blank env var is treated as absent -> not pinned, org value drives.
  const blank = Object.fromEntries(describeSettings({ TICKET_PROVIDER: '' }, { TICKET_PROVIDER: 'trello' }).map((v) => [v.key, v]));
  assert.equal(blank.TICKET_PROVIDER.envPinned, false);
  assert.equal(blank.TICKET_PROVIDER.value, 'trello', 'org drives when env is blank');
  // Absent env var -> not pinned.
  const absent = Object.fromEntries(describeSettings({}, {}).map((v) => [v.key, v]));
  assert.equal(absent.TICKET_PROVIDER.envPinned, false);
});

test('every org-settable key the worker reads is delivered to it via the run context (WORKER_ORG_SETTING_KEYS)', () => {
  // The worker has no org-settings cache: it resolves env > default locally and gets the
  // org tier ONLY through RunContext.workerSettings, which the api fills from these keys.
  // A key marked readBy:['worker'] + tiers:['org'] that is not on this list is a lie in
  // the /admin UI — accepted there, ignored on the wire (the --max-turns 40 bug).
  const workerOrgKeys = (Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>)
    .filter((k) => SETTINGS[k].readBy.includes('worker') && SETTINGS[k].tiers.includes('org') && !SETTINGS[k].secret)
    // Agent-auth keys already travel on the context as `auth` (resolved by the api's agent-auth.ts).
    .filter((k) => k !== 'AGENT_AUTH_MODE');
  const delivered = new Set<string>(WORKER_ORG_SETTING_KEYS);
  const missing = workerOrgKeys.filter((k) => !delivered.has(k));
  assert.deepEqual(missing, [], `org-settable worker keys not delivered via RunContext.workerSettings: ${missing.join(', ')} — add them to WORKER_ORG_SETTING_KEYS + workerSettingsSchema + routes/runs.ts context`);
});

test('every ROLE_SKILL_* setting is delivered via RunContext.roleSkills (ROLE_SKILL_ORG_SETTING_KEYS)', () => {
  // The skill blobs are org-settable but readBy:['api'] — the worker gets them ONLY through
  // RunContext.roleSkills, which the api fills from exactly these keys. A ROLE_SKILL_* setting
  // (e.g. a new role's) not on this list would be editable in /admin yet never reach the prompt.
  const roleSkillSettings = (Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>)
    .filter((k) => k.startsWith('ROLE_SKILL_'));
  assert.deepEqual(
    [...roleSkillSettings].sort(),
    [...ROLE_SKILL_ORG_SETTING_KEYS].sort(),
    'ROLE_SKILL_ORG_SETTING_KEYS must list exactly the ROLE_SKILL_* settings — add the new key there and resolve it in routes/runs.ts computeRoleSkills',
  );
});

test('every MAX_TURNS_* setting is delivered via workerSettings.maxTurnsByRole (MAX_TURNS_ORG_SETTING_KEYS)', () => {
  const maxTurnsSettings = (Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>)
    .filter((k) => k.startsWith('MAX_TURNS_'));
  assert.deepEqual(
    [...maxTurnsSettings].sort(),
    [...MAX_TURNS_ORG_SETTING_KEYS].sort(),
    'MAX_TURNS_ORG_SETTING_KEYS must list exactly the MAX_TURNS_* settings — add the new key there; routes/runs.ts computeWorkerSettings resolves it',
  );
});

test('registry-only keys (#9) are env-only secrets read by the registry alone', async () => {
  const { REGISTRY_ONLY_ENV, dropRegistryOnlyEnv } = await import('./settings.js');
  for (const k of REGISTRY_ONLY_ENV) {
    const d = SETTINGS[k];
    assert.deepEqual(d.readBy, ['registry'], k);
    assert.deepEqual(d.tiers, ['env'], k);
    assert.equal(d.secret, true, k);
  }
  const env: NodeJS.ProcessEnv = { ASF_SECRET_KEY: 'x', ASF_SECRET_KEY_PREVIOUS: 'y', RUN_EVENT_SECRET: 'z' };
  dropRegistryOnlyEnv(env);
  assert.deepEqual(env, { RUN_EVENT_SECRET: 'z' });
});
