import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { PreflightResult, RunAuth, VertexCheckRequest } from '@asf/shared';
import { adcPath, mintToken, probeModel, runVertexCheck, type VertexCheckDeps } from './vertex-check.js';

const NOW = new Date('2026-03-04T05:06:07.000Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const errBody = (status: number, message: string) => json(status, { error: { code: status, message } });

interface Call { url: string; init?: RequestInit }
const header = (c: Call, name: string): string | undefined => (c.init?.headers as Record<string, string> | undefined)?.[name];
const isModelCall = (c: Call) => c.url.includes(':rawPredict');
const modelOf = (c: Call) => decodeURIComponent(c.url.split('/models/')[1]!.replace(':rawPredict', ''));

/** A scripted fetch: the first matching rule answers; metadata/token/tokeninfo/model calls are routed by URL. */
function harness(opts: {
  adc?: Record<string, unknown> | string | null;
  token?: () => Response;
  tokeninfo?: () => Response;
  metadata?: () => Response;
  model?: (id: string, call: Call) => Response | Promise<Response>;
  claudeCode?: (auth: RunAuth) => PreflightResult;
  env?: NodeJS.ProcessEnv;
}) {
  const calls: Call[] = [];
  const claudeCalls: RunAuth[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, init };
    calls.push(call);
    if (url.startsWith('http://metadata.google.internal')) { if (opts.metadata) return opts.metadata(); throw new Error('ENOTFOUND metadata.google.internal'); }
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return opts.tokeninfo ? opts.tokeninfo() : json(200, {});
    if (url === TOKEN_URL) return opts.token ? opts.token() : json(200, { access_token: 'tok-123' });
    if (isModelCall(call)) return opts.model ? opts.model(modelOf(call), call) : json(200, {});
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const deps: VertexCheckDeps = {
    fetch: fetchFn,
    env: opts.env ?? { HOME: '/home/u' },
    readFile: async (p: string) => {
      if (opts.adc === null || opts.adc === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return typeof opts.adc === 'string' ? opts.adc : JSON.stringify(opts.adc);
    },
    claudeCode: async (auth) => { claudeCalls.push(auth); return opts.claudeCode ? opts.claudeCode(auth) : { ok: true, detail: 'ok' }; },
    now: () => NOW,
  };
  return { deps, calls, claudeCalls };
}

const userAdc = { type: 'authorized_user', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtok' };
const req = (models: string[], region = 'global'): VertexCheckRequest => ({ projectId: 'my-team-ai', region, models });

// ── adcPath ─────────────────────────────────────────────────────────────────

test('adcPath: GOOGLE_APPLICATION_CREDENTIALS, then CLOUDSDK_CONFIG, then HOME/.config/gcloud', () => {
  assert.equal(adcPath({ GOOGLE_APPLICATION_CREDENTIALS: '/k/key.json', CLOUDSDK_CONFIG: '/c', HOME: '/h' }), '/k/key.json');
  assert.equal(adcPath({ CLOUDSDK_CONFIG: '/c', HOME: '/h' }), '/c/application_default_credentials.json');
  assert.equal(adcPath({ HOME: '/h' }), '/h/.config/gcloud/application_default_credentials.json');
});

// ── login ───────────────────────────────────────────────────────────────────

test('no ADC file and no metadata server -> login no_login (gcloud hint); Claude Code is not run', async () => {
  const h = harness({ adc: null });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.login.ok, false);
  assert.equal(r.login.code, 'no_login');
  assert.match(r.login.reason!, /gcloud auth application-default login/);
  assert.match(r.login.reason!, /application_default_credentials\.json/);
  assert.deepEqual(r.models, []);
  assert.equal(r.claudeCode.skipped, true);
  assert.equal(h.claudeCalls.length, 0);
  assert.equal(h.calls.filter(isModelCall).length, 0);
  assert.equal(r.checkedAt, NOW.toISOString());
  assert.ok(h.calls.some((c) => c.url.startsWith('http://metadata.google.internal') && header(c, 'metadata-flavor') === 'Google'), 'metadata server was tried');
});

test('no ADC file but a GCP metadata server: its token is used', async () => {
  const h = harness({ adc: null, metadata: () => json(200, { access_token: 'meta-tok' }), model: () => json(200, {}) });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.login.ok, true);
  assert.equal(r.login.kind, 'gcp-metadata');
  assert.equal(r.ok, true);
  assert.equal(header(h.calls.find(isModelCall)!, 'authorization'), 'Bearer meta-tok');
});

test('an unparsable ADC file is no_login', async () => {
  const r = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: '{not json' }).deps);
  assert.equal(r.login.code, 'no_login');
  assert.match(r.login.reason!, /isn't valid JSON/);
});

test('authorized_user: token endpoint 400 invalid_grant -> login_expired; no model calls, no Claude Code', async () => {
  const h = harness({ adc: userAdc, token: () => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.login.code, 'login_expired');
  assert.equal(r.login.kind, 'authorized_user');
  assert.match(r.login.reason!, /gcloud auth application-default login/);
  assert.equal(h.calls.filter(isModelCall).length, 0);
  assert.equal(h.claudeCalls.length, 0);
  // the refresh-token grant was what we sent
  const tokenCall = h.calls.find((c) => c.url === TOKEN_URL)!;
  const body = new URLSearchParams(String(tokenCall.init!.body));
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'rtok');
  assert.equal(body.get('client_id'), 'cid');
  assert.equal(body.get('client_secret'), 'csecret');
});

test('token endpoint refusing for another reason is login code other, with the status', async () => {
  const r = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: userAdc, token: () => json(401, { error: 'invalid_client', error_description: 'Unauthorized' }) }).deps);
  assert.equal(r.login.code, 'other');
  assert.match(r.login.reason!, /401/);
});

test('token endpoint unreachable -> login unreachable', async () => {
  const h = harness({ adc: userAdc, token: () => { throw new Error('ECONNREFUSED'); } });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.login.code, 'unreachable');
  assert.equal(h.claudeCalls.length, 0);
});

test('service_account: posts a jwt-bearer grant whose RS256 JWT verifies and carries the cloud-platform scope', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    type: 'service_account', client_email: 'bot@my-team-ai.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: TOKEN_URL,
  };
  const h = harness({ adc: sa });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.login.kind, 'service_account');
  assert.equal(r.login.account, 'bot@my-team-ai.iam.gserviceaccount.com');

  const tokenCall = h.calls.find((c) => c.url === TOKEN_URL)!;
  assert.equal(tokenCall.init!.method, 'POST');
  assert.equal(header(tokenCall, 'content-type'), 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(String(tokenCall.init!.body));
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = body.get('assertion')!;
  const [h64, p64, s64] = jwt.split('.') as [string, string, string];
  const v = createVerify('RSA-SHA256').update(`${h64}.${p64}`);
  assert.equal(v.verify(publicKey, Buffer.from(s64, 'base64url')), true, 'signature verifies with the public key');
  assert.deepEqual(JSON.parse(Buffer.from(h64, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p64, 'base64url').toString()) as Record<string, unknown>;
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(claims.iat, Math.floor(NOW.getTime() / 1000));
  assert.equal(claims.exp, Math.floor(NOW.getTime() / 1000) + 600);
  assert.equal(h.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/tokeninfo')), false, 'a service account already knows its email');
});

test('service_account with an unreadable private key -> no_login', async () => {
  const r = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: { type: 'service_account', client_email: 'x@y', private_key: 'garbage' } }).deps);
  assert.equal(r.login.code, 'no_login');
  assert.match(r.login.reason!, /can't be read/);
});

test('mintToken: authorized_user success looks up the account from tokeninfo; quota_project_id is returned', async () => {
  const h = harness({ adc: { ...userAdc, quota_project_id: 'billing-proj' }, tokeninfo: () => json(200, { email: 'me@corp.com' }) });
  const l = await mintToken(h.deps);
  assert.deepEqual(l, { ok: true, token: 'tok-123', kind: 'authorized_user', account: 'me@corp.com', quotaProject: 'billing-proj' });
});

// ── models ──────────────────────────────────────────────────────────────────

test('success path: 200 / 404 / 429 -> ok / not_enabled / ok-with-reason; Claude Code runs once on the first ok balanced model', async () => {
  const h = harness({
    adc: userAdc, tokeninfo: () => json(200, { email: 'me@corp.com' }),
    model: (id) => id === 'claude-opus-5-5' ? errBody(404, 'Publisher Model was not found')
      : id === 'claude-sonnet-5' ? errBody(429, 'Quota exceeded')
      : json(200, { content: [] }),
  });
  const r = await runVertexCheck(req(['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5@20251001', 'claude-opus-4-8']), h.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.login, { ok: true, kind: 'authorized_user', account: 'me@corp.com' });
  const by = Object.fromEntries(r.models.map((m) => [m.id, m]));
  assert.equal(by['claude-opus-5-5']!.ok, false);
  assert.equal(by['claude-opus-5-5']!.code, 'not_enabled');
  assert.equal(by['claude-opus-5-5']!.tier, 'max');
  assert.equal(by['claude-sonnet-5']!.ok, true);
  assert.match(by['claude-sonnet-5']!.reason!, /busy|rate limit/i);
  assert.equal(by['claude-sonnet-5']!.tier, 'balanced');
  assert.equal(by['claude-haiku-4-5@20251001']!.ok, true);
  assert.equal(by['claude-haiku-4-5@20251001']!.tier, 'fast');
  assert.equal(by['claude-haiku-4-5@20251001']!.reason, undefined);

  assert.equal(h.claudeCalls.length, 1);
  assert.deepEqual(h.claudeCalls[0], {
    providerKind: 'anthropic', mode: 'vertex',
    vertex: { projectId: 'my-team-ai', region: 'global', defaultModel: 'claude-sonnet-5', fastModel: 'claude-haiku-4-5@20251001', maxModel: 'claude-opus-4-8' },
  });
  assert.deepEqual(r.claudeCode, { ok: true, model: 'claude-sonnet-5' });
});

test('the model request is a 1-token Messages body with the bearer token to the regional endpoint', async () => {
  const h = harness({ adc: userAdc });
  await runVertexCheck(req(['claude-sonnet-5'], 'us-east5'), h.deps);
  const c = h.calls.find(isModelCall)!;
  assert.equal(c.url, 'https://us-east5-aiplatform.googleapis.com/v1/projects/my-team-ai/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:rawPredict');
  assert.equal(c.init!.method, 'POST');
  assert.equal(header(c, 'authorization'), 'Bearer tok-123');
  const body = JSON.parse(String(c.init!.body)) as { anthropic_version: string; max_tokens: number; messages: unknown[] };
  assert.equal(body.anthropic_version, 'vertex-2023-10-16');
  assert.equal(body.max_tokens, 1);
  assert.equal(body.messages.length, 1);
});

test('a regional 404 reason names the region; a global 404 does not', async () => {
  const regional = await runVertexCheck(req(['claude-sonnet-5', 'claude-haiku-4-5@20251001'], 'us-east5'),
    harness({ adc: userAdc, model: (id) => id === 'claude-sonnet-5' ? errBody(404, 'nf') : json(200, {}) }).deps);
  const m = regional.models.find((x) => x.id === 'claude-sonnet-5')!;
  assert.equal(m.code, 'not_enabled');
  assert.match(m.reason!, /us-east5/);
  const global = await runVertexCheck(req(['claude-sonnet-5', 'claude-haiku-4-5@20251001']),
    harness({ adc: userAdc, model: (id) => id === 'claude-sonnet-5' ? errBody(404, 'nf') : json(200, {}) }).deps);
  assert.match(global.models.find((x) => x.id === 'claude-sonnet-5')!.reason!, /Model Garden/);
  assert.doesNotMatch(global.models.find((x) => x.id === 'claude-sonnet-5')!.reason!, /in global/);
});

test('every model 403 PERMISSION_DENIED -> collapsed to a login step no_permission; Claude Code skipped', async () => {
  const h = harness({ adc: userAdc, tokeninfo: () => json(200, { email: 'me@corp.com' }), model: () => errBody(403, 'PERMISSION_DENIED: Permission aiplatform.endpoints.predict denied') });
  const r = await runVertexCheck(req(['claude-sonnet-5', 'claude-opus-4-8']), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.login.ok, false);
  assert.equal(r.login.code, 'no_permission');
  assert.match(r.login.reason!, /Vertex AI User/);
  assert.equal(r.login.account, 'me@corp.com');
  assert.equal(r.models.length, 2, 'per-model results are still returned');
  assert.equal(r.claudeCode.skipped, true);
  assert.equal(h.claudeCalls.length, 0);
});

test('403 SERVICE_DISABLED -> api_disabled; 403 project not found -> bad_project', async () => {
  const dis = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: userAdc, model: () => errBody(403, 'Vertex AI API has not been used in project 1234 before or it is disabled. SERVICE_DISABLED') }).deps);
  assert.equal(dis.login.code, 'api_disabled');
  assert.match(dis.login.reason!, /my-team-ai/);
  const nf = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: userAdc, model: () => errBody(403, 'Project my-team-ai not found or you do not have access') }).deps);
  assert.equal(nf.login.code, 'bad_project');
});

test('fetch rejecting for models -> unreachable on the login step', async () => {
  const h = harness({ adc: userAdc, model: () => { throw new Error('ETIMEDOUT'); } });
  const r = await runVertexCheck(req(['claude-sonnet-5', 'claude-opus-4-8']), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.login.code, 'unreachable');
  assert.ok(r.models.every((m) => m.code === 'unreachable'));
  assert.equal(h.claudeCalls.length, 0);
});

test('a permission error on only SOME models is not collapsed: the others stay usable', async () => {
  const h = harness({ adc: userAdc, model: (id) => id === 'claude-opus-4-8' ? errBody(403, 'PERMISSION_DENIED') : json(200, {}) });
  const r = await runVertexCheck(req(['claude-opus-4-8', 'claude-sonnet-5']), h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.login.ok, true);
  assert.equal(r.models.find((m) => m.id === 'claude-opus-4-8')!.code, 'no_permission');
});

test('all models 404 -> no Claude Code, ok false, claudeCode skipped with a reason', async () => {
  const h = harness({ adc: userAdc, model: () => errBody(404, 'nf') });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.login.ok, true);
  assert.equal(r.claudeCode.skipped, true);
  assert.equal(h.claudeCalls.length, 0);
});

test('probeModel: 401 -> login_expired, 400 mentioning the project -> bad_project, 500 -> other', async () => {
  const probe = (res: Response) => probeModel({ projectId: 'p', region: 'global', model: 'claude-sonnet-5' }, { token: 't' }, (async () => res) as unknown as typeof fetch);
  assert.equal((await probe(errBody(401, 'bad token'))).code, 'login_expired');
  assert.equal((await probe(errBody(400, 'Invalid project id'))).code, 'bad_project');
  const other = await probe(errBody(500, 'boom'));
  assert.equal(other.code, 'other');
  assert.match(other.reason!, /500/);
});

test('a quota_project_id in the ADC is sent as x-goog-user-project on model calls; absent otherwise', async () => {
  const withQuota = harness({ adc: { ...userAdc, quota_project_id: 'billing-proj' } });
  await runVertexCheck(req(['claude-sonnet-5']), withQuota.deps);
  assert.equal(header(withQuota.calls.find(isModelCall)!, 'x-goog-user-project'), 'billing-proj');
  const without = harness({ adc: userAdc });
  await runVertexCheck(req(['claude-sonnet-5']), without.deps);
  assert.equal(header(without.calls.find(isModelCall)!, 'x-goog-user-project'), undefined);
});

// ── Claude Code ─────────────────────────────────────────────────────────────

test('Claude Code failing -> ok false, claudeCode.code claude_code_failed with the reason; the model rows stay ok', async () => {
  const h = harness({ adc: userAdc, claudeCode: () => ({ ok: false, reason: 'API Error: 403 quota' }) });
  const r = await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.claudeCode.ok, false);
  assert.equal(r.claudeCode.code, 'claude_code_failed');
  assert.equal(r.claudeCode.model, 'claude-sonnet-5');
  assert.match(r.claudeCode.reason!, /API Error: 403 quota/);
  assert.equal(r.login.ok, true);
  assert.equal(r.models[0]!.ok, true);
});

test('without a claudeCode dep the check cannot pass (Claude Code not exercised)', async () => {
  const h = harness({ adc: userAdc });
  const r = await runVertexCheck(req(['claude-sonnet-5']), { ...h.deps, claudeCode: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.claudeCode.skipped, true);
});

test('fast and max models fall back to the default model when none of that tier works', async () => {
  const h = harness({ adc: userAdc });
  await runVertexCheck(req(['claude-sonnet-5']), h.deps);
  assert.deepEqual(h.claudeCalls[0]!.vertex, { projectId: 'my-team-ai', region: 'global', defaultModel: 'claude-sonnet-5', fastModel: 'claude-sonnet-5', maxModel: 'claude-sonnet-5' });
});

test('a non-balanced working model is still used when no balanced one works', async () => {
  const h = harness({ adc: userAdc, model: (id) => id === 'claude-haiku-4-5@20251001' ? json(200, {}) : errBody(404, 'nf') });
  const r = await runVertexCheck(req(['claude-sonnet-5', 'claude-haiku-4-5@20251001']), h.deps);
  assert.equal(r.ok, true);
  assert.equal(h.claudeCalls[0]!.vertex!.defaultModel, 'claude-haiku-4-5@20251001');
});

test('unsupported credential kind: models are not probed, Claude Code decides; passing marks the login and that model ok', async () => {
  const h = harness({ adc: { type: 'external_account' } });
  const r = await runVertexCheck(req(['claude-opus-4-8', 'claude-sonnet-5']), h.deps);
  assert.equal(h.calls.filter(isModelCall).length, 0);
  assert.equal(h.claudeCalls.length, 1);
  assert.equal(h.claudeCalls[0]!.vertex!.defaultModel, 'claude-sonnet-5');
  assert.equal(r.login.code, 'unsupported_login');
  assert.equal(r.login.ok, true, 'a passing Claude Code makes the login step ok');
  assert.equal(r.ok, true);
  assert.equal(r.models.find((m) => m.id === 'claude-sonnet-5')!.ok, true);
  assert.equal(r.models.find((m) => m.id === 'claude-opus-4-8')!.ok, false);
});

test('unsupported credential kind and Claude Code fails -> not ok', async () => {
  const r = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: { type: 'external_account' }, claudeCode: () => ({ ok: false, reason: 'no creds' }) }).deps);
  assert.equal(r.ok, false);
  assert.equal(r.login.ok, false);
  assert.equal(r.claudeCode.code, 'claude_code_failed');
});

test('runVertexCheck never throws on a bad service-account key or garbage env', async () => {
  const r = await runVertexCheck(req(['claude-sonnet-5']), harness({ adc: { type: 'service_account' }, env: {} }).deps);
  assert.equal(r.ok, false);
});
