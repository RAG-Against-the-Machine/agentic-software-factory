/**
 * The Vertex check, run on the worker (M9): the only process that holds the
 * Google login (host Application Default Credentials, mounted read-only).
 *
 *   1. Login: find the ADC (GOOGLE_APPLICATION_CREDENTIALS, else the gcloud
 *      default file, else the metadata server on GCP) and mint an access token.
 *   2. Models: one tiny Messages request per candidate (max_tokens 1, well under
 *      a cent each) to Vertex's rawPredict. A 404 = not enabled for the project
 *      or region, a 403 = no permission / API off, 429 = it exists (just busy).
 *   3. Claude Code: one real `claude -p` on the best working model, with exactly
 *      the env a run gets, so a ✓ means runs will work, not just the REST call.
 * Each failure carries a code + a sentence the UI shows as the fix.
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelTier, PreflightResult, RunAuth, VertexCheckCode, VertexCheckRequest, VertexCheckResult } from '@asf/shared';
import { VERTEX_CANDIDATES, vertexCheckModel, vertexModelUrl, vertexTier } from '@asf/shared';

type Fetch = typeof fetch;
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const LOGIN_FIX = 'On the computer running the factory, run: gcloud auth application-default login — then check again (no restart needed).';

export interface VertexCheckDeps {
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  /** Run Claude Code once with this auth (the claude-code runtime's preflight). */
  claudeCode?: (auth: RunAuth) => Promise<PreflightResult>;
  now?: () => Date;
}

interface Login { ok: true; token: string; account?: string; kind: string; quotaProject?: string }
interface LoginFail { ok: false; code: VertexCheckCode; reason: string; kind?: string }

/** The ADC file a Google client library would use, in the same order. */
export function adcPath(env: NodeJS.ProcessEnv): string {
  return env.GOOGLE_APPLICATION_CREDENTIALS || join(env.CLOUDSDK_CONFIG || join(env.HOME || homedir(), '.config', 'gcloud'), 'application_default_credentials.json');
}

export async function mintToken(deps: VertexCheckDeps = {}): Promise<Login | LoginFail> {
  const f = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const rd = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const path = adcPath(env);
  let raw: string | null = null;
  try { raw = await rd(path); } catch { raw = null; }
  if (raw === null) {
    // No file: on GCP (Cloud Run, GCE) the metadata server is the login.
    const md = await f('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (md?.ok) {
      const j = await md.json().catch(() => ({})) as { access_token?: string };
      if (j.access_token) return { ok: true, token: j.access_token, kind: 'gcp-metadata' };
    }
    return { ok: false, code: 'no_login', reason: `No Google login found on the worker (looked for ${path}). ${LOGIN_FIX}` };
  }
  let cred: Record<string, string>;
  try { cred = JSON.parse(raw); } catch { return { ok: false, code: 'no_login', reason: `The Google login file ${path} isn't valid JSON. ${LOGIN_FIX}` }; }
  const kind = cred.type ?? 'unknown';
  let body: URLSearchParams;
  if (kind === 'authorized_user') {
    body = new URLSearchParams({ grant_type: 'refresh_token', client_id: cred.client_id ?? '', client_secret: cred.client_secret ?? '', refresh_token: cred.refresh_token ?? '' });
  } else if (kind === 'service_account') {
    const iat = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: cred.client_email, scope: SCOPE, aud: cred.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 600 })}`;
    let sig: string;
    try { sig = createSign('RSA-SHA256').update(unsigned).sign(cred.private_key ?? '').toString('base64url'); } catch {
      return { ok: false, code: 'no_login', kind, reason: `The service-account key in ${path} can't be read. Download a fresh key, or use gcloud auth application-default login instead.` };
    }
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` });
  } else {
    return { ok: false, code: 'unsupported_login', kind, reason: `The Google login on the worker is a “${kind}” credential, which this check can't test directly. Claude Code will still be tried; if it fails, use gcloud auth application-default login.` };
  }
  const res = await f(cred.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) return { ok: false, code: 'unreachable', kind, reason: 'The worker couldn’t reach Google to sign in (oauth2.googleapis.com). Check its internet connection; if your company uses a web proxy, the worker needs it too.' };
  const j = await res.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string; error_subtype?: string };
  if (!res.ok || !j.access_token) {
    if (j.error === 'invalid_grant' || j.error === 'invalid_rapt' || /reauth|rapt|expired|revoked/i.test(`${j.error_description ?? ''} ${j.error_subtype ?? ''}`)) {
      return { ok: false, code: 'login_expired', kind, reason: `Your Google login has expired or needs you to sign in again. ${LOGIN_FIX}` };
    }
    return { ok: false, code: 'other', kind, reason: `Google refused the login (${res.status} ${j.error ?? ''} ${j.error_description ?? ''}). ${LOGIN_FIX}`.replace(/\s+/g, ' ') };
  }
  let account = kind === 'service_account' ? cred.client_email : undefined;
  if (!account) {
    // Best effort: who is this? (gcloud's ADC scopes include the email.)
    const info = await f(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(j.access_token)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const ij = info?.ok ? await info.json().catch(() => ({})) as { email?: string } : {};
    account = ij.email;
  }
  return { ok: true, token: j.access_token, kind, ...(account ? { account } : {}), ...(cred.quota_project_id ? { quotaProject: cred.quota_project_id } : {}) };
}

/** One tiny request to one model. */
export async function probeModel(
  req: { projectId: string; region: string; model: string },
  login: Pick<Login, 'token' | 'quotaProject'>,
  f: Fetch = fetch,
): Promise<{ ok: boolean; code?: VertexCheckCode; reason?: string }> {
  const res = await f(vertexModelUrl(req.projectId, req.region, req.model), {
    method: 'POST',
    headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json', ...(login.quotaProject ? { 'x-goog-user-project': login.quotaProject } : {}) },
    body: JSON.stringify({ anthropic_version: 'vertex-2023-10-16', messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!res) return { ok: false, code: 'unreachable', reason: 'The worker couldn’t reach Vertex AI (aiplatform.googleapis.com). Check its internet connection or proxy.' };
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  const msg = (() => { try { return String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text); } catch { return text; } })().slice(0, 300);
  if (res.status === 429) return { ok: true, reason: 'Enabled (busy right now: the project hit its rate limit).' };
  if (res.status === 404) {
    return { ok: false, code: 'not_enabled', reason: req.region === 'global'
      ? 'Not enabled for this project. Ask your Google Cloud admin to enable it in Vertex AI → Model Garden, or untick it.'
      : `Not enabled for this project in ${req.region}. Try region global, or enable it in Vertex AI → Model Garden.` };
  }
  if (res.status === 403) {
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(msg)) return { ok: false, code: 'api_disabled', reason: `The Vertex AI API is turned off for project ${req.projectId}. Ask your Google Cloud admin to enable “Vertex AI API” for it.` };
    if (/not found|does not exist|invalid project/i.test(msg)) return { ok: false, code: 'bad_project', reason: `Google can’t find project ${req.projectId}, or you can’t see it. Check the project id (not its name).` };
    return { ok: false, code: 'no_permission', reason: `Your Google account isn’t allowed to use Claude in project ${req.projectId}. Ask your Google Cloud admin for the “Vertex AI User” role on it.` };
  }
  if (res.status === 401) return { ok: false, code: 'login_expired', reason: `Google didn’t accept the login. ${LOGIN_FIX}` };
  if (res.status === 400 && /project/i.test(msg)) return { ok: false, code: 'bad_project', reason: `Google rejected project ${req.projectId}: ${msg}` };
  return { ok: false, code: 'other', reason: `Vertex AI answered ${res.status}: ${msg || 'no details'}` };
}

/** The whole check; never throws (a failure is a result). */
export async function runVertexCheck(req: VertexCheckRequest, deps: VertexCheckDeps = {}): Promise<VertexCheckResult> {
  const f = deps.fetch ?? fetch;
  const at = () => (deps.now?.() ?? new Date()).toISOString();
  const tierOf = (id: string): ModelTier => VERTEX_CANDIDATES.find((c) => c.id === id)?.tier ?? vertexTier(id);
  const login = await mintToken(deps);
  if (!login.ok && login.code !== 'unsupported_login') {
    return { ok: false, login: { ok: false, code: login.code, reason: login.reason, ...(login.kind ? { kind: login.kind } : {}) }, models: [], claudeCode: { ok: false, skipped: true }, checkedAt: at() };
  }
  let models: VertexCheckResult['models'];
  if (login.ok) {
    models = await Promise.all(req.models.map(async (id) => ({ id, tier: tierOf(id), ...(await probeModel({ ...req, model: id }, login, f)) })));
    // One failure that applies to the whole project: say it once, as the login step.
    const shared = models.find((m) => m.code && ['no_permission', 'api_disabled', 'bad_project', 'unreachable', 'login_expired'].includes(m.code));
    if (shared && models.every((m) => !m.ok)) {
      return { ok: false, login: { ok: false, code: shared.code, reason: shared.reason, kind: login.kind, ...(login.account ? { account: login.account } : {}) }, models, claudeCode: { ok: false, skipped: true }, checkedAt: at() };
    }
  } else {
    // A login we can't mint ourselves: no per-model answer, Claude Code decides.
    models = req.models.map((id) => ({ id, tier: tierOf(id), ok: false, code: 'unsupported_login' as const, reason: 'Not checked (see the login note).' }));
  }
  const ccModel = vertexCheckModel(models) ?? (login.ok ? null : req.models.find((m) => tierOf(m) === 'balanced') ?? req.models[0]);
  let claudeCode: VertexCheckResult['claudeCode'] = { ok: false, skipped: true, reason: 'No model worked, so Claude Code wasn’t tried.' };
  if (ccModel && deps.claudeCode) {
    const fast = models.find((m) => m.ok && m.tier === 'fast')?.id ?? ccModel;
    const max = models.find((m) => m.ok && m.tier === 'max')?.id ?? ccModel;
    const r = await deps.claudeCode({ providerKind: 'anthropic', mode: 'vertex', vertex: { projectId: req.projectId, region: req.region, defaultModel: ccModel, fastModel: fast, maxModel: max } });
    claudeCode = r.ok ? { ok: true, model: ccModel } : { ok: false, model: ccModel, code: 'claude_code_failed', reason: `The models answer, but Claude Code itself failed on ${ccModel}: ${r.reason ?? 'no reason given'}` };
    if (!login.ok && r.ok) models = models.map((m) => (m.id === ccModel ? { id: m.id, tier: m.tier, ok: true } : m));
  }
  const loginStep: VertexCheckResult['login'] = login.ok
    ? { ok: true, kind: login.kind, ...(login.account ? { account: login.account } : {}) }
    : { ok: claudeCode.ok, code: login.code, reason: login.reason, ...(login.kind ? { kind: login.kind } : {}) };
  return { ok: loginStep.ok && models.some((m) => m.ok) && claudeCode.ok, login: loginStep, models, claudeCode, checkedAt: at() };
}
