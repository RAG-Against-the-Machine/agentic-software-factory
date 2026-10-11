import { cfg } from './settings.js';
import { computeRunAuth } from './agent-auth.js';

/**
 * "Save and check it works" for an OpenAI API key (#162). A plain-language
 * answer for a non-technical operator, not a status code.
 *
 * It sends one real, tiny request (`POST /v1/responses`, 16 output tokens, well
 * under a cent) to the model the team will use. A metadata call like
 * GET /v1/models succeeds on a project with no credit, and "out of credit" is
 * the most common way a fresh key fails. The request is the same call Codex
 * makes, so a ✓ here means Codex will work.
 */
export type OpenAiCheck =
  | { ok: true; identity: string }
  | { ok: false; code: 'no_key' | 'invalid_key' | 'no_model_access' | 'no_credit' | 'rate_limited' | 'unreachable' | 'other'; reason: string };

export const OPENAI_CHECK_MODEL_FALLBACK = 'gpt-6-sol';

/** The GPT model the team is set to use (the implementer's, else any role's), else the fallback. */
export function modelToCheck(get: (k: string) => unknown = cfg as never): string {
  for (const role of ['IMPLEMENTER', 'PLANNER', 'REVIEWER', 'TESTER']) {
    const m = String(get(`MODEL_DEFAULT_${role}`) ?? '');
    if (m.startsWith('gpt-') || /^o\d/.test(m)) return m;
  }
  return OPENAI_CHECK_MODEL_FALLBACK;
}

export async function checkOpenAiKey(opts: { key?: string; baseUrl?: string; model?: string; fetchImpl?: typeof fetch } = {}): Promise<OpenAiCheck> {
  const auth = opts.key === undefined ? await computeRunAuth('openai') : null;
  const key = (opts.key ?? auth?.credential ?? '').trim();
  if (!key) return { ok: false, code: 'no_key', reason: 'No OpenAI API key is saved yet. Paste one above.' };
  const base = (opts.baseUrl ?? auth?.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model ?? modelToCheck();
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${base}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'Reply with: ok', max_output_tokens: 16 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, code: 'unreachable', reason: 'Couldn’t reach OpenAI from this server. Check its internet connection and try again.' };
  }
  if (res.ok) return { ok: true, identity: `OpenAI (${model})` };
  const body = await res.json().catch(() => ({})) as { error?: { code?: string; type?: string; message?: string } };
  const err = body.error ?? {};
  const code = `${err.code ?? ''} ${err.type ?? ''}`;
  if (res.status === 401) return { ok: false, code: 'invalid_key', reason: 'OpenAI didn’t accept that key. Copy the whole key (it starts with sk-) and paste it again, or create a new one.' };
  if (res.status === 429 && /insufficient_quota|credit_balance|billing|no credits/i.test(code + (err.message ?? ''))) {
    return { ok: false, code: 'no_credit', reason: 'The key works, but its OpenAI project has no credit. In platform.openai.com open Settings → Billing, add credit or a payment method, and check the project’s budget isn’t $0. Then check again.' };
  }
  if (res.status === 429) return { ok: false, code: 'rate_limited', reason: 'OpenAI is rate-limiting this key right now. Wait a minute and check again.' };
  if (res.status === 403 || res.status === 404 || /model_not_found|permission/i.test(code)) {
    return { ok: false, code: 'no_model_access', reason: `The key works, but its project isn’t allowed to use ${model}. In platform.openai.com open your project → Limits and allow ${model} (or all models), then check again.` };
  }
  return { ok: false, code: 'other', reason: `OpenAI answered ${res.status}: ${err.message ?? 'unknown error'}` };
}
