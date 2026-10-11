import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreflightResult, RunAuth } from '@asf/shared';
import { preflightAgentAuth } from './auth-preflight.js';

// preflightAgentAuth boot behavior (M8 WP C: per runtime). The credential lives in
// the org secret sink (only the api resolves it), so a fresh worker must be able to
// register on the api's presence signal and defer the real credential test to first
// run — otherwise a UI-entered credential can never bring the worker up. The
// runtime's own preflight() is the live check; a fake records whether it ran.
// (The spawn-env strip-then-set tests moved to auth/auth.test.ts.)
function fakeRuntime(result: PreflightResult = { ok: true, detail: 'live' }) {
  const calls: RunAuth[] = [];
  return { calls, preflight: async (a: RunAuth) => { calls.push(a); return result; } };
}
const anth = (mode: string, credential?: string): RunAuth => ({ providerKind: 'anthropic', mode, ...(credential ? { credential } : {}) });

test('no literal credential but credentialPresent=true registers without spawning (deferred test)', async () => {
  for (const mode of ['oauth-token', 'api-key']) {
    const rt = fakeRuntime();
    const r = await preflightAgentAuth(rt, anth(mode), { credentialPresent: true });
    assert.equal(r.ok, true, mode);
    assert.match((r as { detail: string }).detail, /credential present at the api/);
    assert.equal(rt.calls.length, 0, 'no live call on the health path');
  }
});

test('no credential anywhere fails with a clear, actionable reason naming the setting — for every provider', async () => {
  const want: Array<[RunAuth, RegExp]> = [
    [anth('oauth-token'), /CLAUDE_CODE_OAUTH_TOKEN/], [anth('api-key'), /ANTHROPIC_API_KEY/],
    [{ providerKind: 'openai', mode: 'api-key' }, /OPENAI_API_KEY/],
    [{ providerKind: 'openai-compatible', mode: 'api-key', baseUrl: 'http://x/v1' }, /OPENAI_COMPAT_API_KEY/],
    [{ providerKind: 'github', mode: 'gh-token' }, /GITHUB_COPILOT_TOKEN/],
  ];
  for (const [auth, re] of want) {
    const rt = fakeRuntime();
    const r = await preflightAgentAuth(rt, auth, { credentialPresent: false });
    assert.equal(r.ok, false, auth.providerKind);
    assert.match((r as { reason: string }).reason, re);
    assert.match((r as { reason: string }).reason, /Settings → Which AI should do the work\?/);
    assert.equal(rt.calls.length, 0);
  }
});

test('a literal credential, or a mode that needs none, runs the RUNTIME\'s own live preflight', async () => {
  const rt = fakeRuntime({ ok: false, reason: 'Invalid API key' });
  assert.deepEqual(await preflightAgentAuth(rt, anth('api-key', 'CTX')), { ok: false, reason: 'Invalid API key' });
  assert.equal(rt.calls[0].credential, 'CTX');
  const rt2 = fakeRuntime();
  assert.equal((await preflightAgentAuth(rt2, { providerKind: 'openai', mode: 'chatgpt' })).ok, true);
  assert.equal(rt2.calls.length, 1, 'no "no preflight for runtime X" pass-through any more');
});

test('vertex without a project fails before any spawn', async () => {
  const saved = process.env.ANTHROPIC_VERTEX_PROJECT_ID; delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  try {
    const rt = fakeRuntime();
    const r = await preflightAgentAuth(rt, anth('vertex'));
    assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /ANTHROPIC_VERTEX_PROJECT_ID/);
    assert.equal(rt.calls.length, 0);
  } finally { if (saved !== undefined) process.env.ANTHROPIC_VERTEX_PROJECT_ID = saved; }
});
