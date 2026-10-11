import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOpenAiKey, modelToCheck } from './openai-check.js';

// Bodies captured from the live API on 2026-09-29.
const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const NO_CREDIT = { error: { message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.', type: 'insufficient_quota', param: null, code: 'credit_balance_exhausted' } };
const BAD_KEY = { error: { message: 'Incorrect API key provided: sk-bogus.', type: 'invalid_request_error', code: 'invalid_api_key', param: null }, status: 401 };
const NO_MODEL = { error: { message: 'The model `gpt-6-sol` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } };
const RATE = { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } };

const run = (fetchImpl: typeof fetch, key = 'sk-test') => checkOpenAiKey({ key, model: 'gpt-6-sol', fetchImpl });

test('a working key: plain ✓ naming the model', async () => {
  assert.deepEqual(await run(reply(200, { id: 'resp_1' })), { ok: true, identity: 'OpenAI (gpt-6-sol)' });
});

test('each failure gets its own plain-language answer', async () => {
  const cases: Array<[typeof fetch, string, RegExp]> = [
    [reply(401, BAD_KEY), 'invalid_key', /didn’t accept that key/],
    [reply(429, NO_CREDIT), 'no_credit', /no credit.*Billing/],
    [reply(404, NO_MODEL), 'no_model_access', /isn’t allowed to use gpt-6-sol.*Limits/],
    [reply(403, { error: { code: 'permission_denied' } }), 'no_model_access', /Limits/],
    [reply(429, RATE), 'rate_limited', /Wait a minute/],
    [reply(500, { error: { message: 'boom' } }), 'other', /500: boom/],
  ];
  for (const [f, code, text] of cases) {
    const r = await run(f);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.code, code); assert.match(r.reason, text); }
  }
});

test('no key saved: says so without calling OpenAI', async () => {
  let called = false;
  const r = await run((async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch, '  ');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'no_key');
  assert.equal(called, false);
});

test('network failure reads as unreachable, not as a bad key', async () => {
  const r = await run((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
  assert.equal(!r.ok && r.code, 'unreachable');
});

test('it makes one real, tiny request (a metadata call passes on a project with no credit)', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  await checkOpenAiKey({ key: 'sk-x', model: 'gpt-6-sol', baseUrl: 'https://proxy.example/v1/', fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{}'); }) as unknown as typeof fetch });
  assert.equal(seen!.url, 'https://proxy.example/v1/responses');
  assert.equal(seen!.init.method, 'POST');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer sk-x');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { model: 'gpt-6-sol', input: 'Reply with: ok', max_output_tokens: 16 });
});

test('it checks the GPT model the team is set to use, else GPT-6 Sol', () => {
  assert.equal(modelToCheck(() => 'claude-opus-4-8'), 'gpt-6-sol');
  assert.equal(modelToCheck((k) => (k === 'MODEL_DEFAULT_IMPLEMENTER' ? 'gpt-6-astra' : 'claude-sonnet-5')), 'gpt-6-astra');
});
