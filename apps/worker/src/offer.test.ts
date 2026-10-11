import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRuntime, ProviderKind } from '@asf/shared';
import { RuntimeOffer, type ProviderAuthView } from './offer.js';

const rt = (kind: string) => ({ kind }) as unknown as AgentRuntime;

function harness(initial: Record<string, ProviderAuthView | null>) {
  const views = { ...initial };
  const passes = new Set<string>();
  const calls: string[] = [];
  let t = 0;
  const offer = new RuntimeOffer(
    [{ runtime: rt('claude-code'), provider: 'anthropic' }, { runtime: rt('codex'), provider: 'openai' }],
    async (r, auth, o) => { calls.push(`${r.kind}:${auth.mode}:${o.credentialPresent}`); return passes.has(r.kind) ? { ok: true } : { ok: false, reason: 'no key' }; },
    () => {}, 600_000, () => t,
  );
  const refresh = () => offer.refresh((p: ProviderKind) => views[p] ?? null, () => 'unset');
  return { offer, views, passes, calls, refresh, tick: (ms: number) => { t += ms; } };
}

test('boot: offers what passes, keeps the rest pending', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: null });
  h.passes.add('claude-code');
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, ['claude-code']);
  assert.deepEqual(h.offer.pending, ['codex']);
});

test('a key entered in Settings brings the pending runtime online on the next refresh, no restart', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: null });
  h.passes.add('claude-code');
  await h.refresh();
  // Nothing changed: the pending runtime is not re-preflighted on every heartbeat (each is a model call).
  h.calls.length = 0;
  assert.equal(await h.refresh(), false);
  assert.deepEqual(h.calls, []);
  // Operator saves an OpenAI key: the api's view changes -> re-checked immediately.
  h.views.openai = { mode: 'api-key', credentialPresent: true };
  h.passes.add('codex');
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.calls, ['codex:api-key:true']);
  assert.deepEqual(h.offer.kinds, ['claude-code', 'codex']);
  assert.deepEqual(h.offer.pending, []);
});

test('an unchanged failure is re-tried after recheckMs (e.g. billing fixed on the provider side)', async () => {
  const h = harness({ openai: { mode: 'api-key', credentialPresent: true } });
  await h.refresh();
  h.calls.length = 0;
  h.passes.add('codex');
  h.tick(599_999);
  assert.equal(await h.refresh(), false);
  assert.ok(!h.calls.some((c) => c.startsWith('codex')), 'not yet due');
  h.tick(1);
  assert.equal(await h.refresh(), true);
  assert.deepEqual(h.offer.kinds, ['codex']);
});

test('an offered runtime is never re-preflighted (a later credential failure surfaces on the run)', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true } });
  h.passes.add('claude-code');
  await h.refresh();
  h.calls.length = 0;
  h.views.anthropic = { mode: 'oauth', credentialPresent: true };
  h.tick(10 * 600_000);
  await h.refresh();
  assert.ok(!h.calls.some((c) => c.startsWith('claude-code')));
  assert.deepEqual(h.offer.kinds, ['claude-code']);
});

test('status reports every configured runtime and flips to ok once the key view changes (#69)', async () => {
  const h = harness({ anthropic: { mode: 'api-key', credentialPresent: true }, openai: null });
  h.passes.add('claude-code');
  h.offer.notInstalled('hermes', 'not installed on this worker');
  await h.refresh();
  const before = Object.fromEntries(h.offer.status.map((s) => [s.kind, s]));
  assert.equal(before['claude-code'].ok, true);
  assert.equal(before['claude-code'].reason, undefined);
  assert.equal(before.codex.ok, false);
  assert.equal(before.codex.installed, true);
  assert.equal(before.codex.reason, 'no key');
  assert.deepEqual([before.hermes.installed, before.hermes.ok, before.hermes.reason], [false, false, 'not installed on this worker']);

  h.views.openai = { mode: 'api-key', credentialPresent: true };
  h.passes.add('codex');
  await h.refresh();
  const codex = h.offer.status.find((s) => s.kind === 'codex')!;
  assert.equal(codex.ok, true);
  assert.equal(codex.reason, undefined);
});

test('container rule (#70): a runtime that cannot confine its own writes is refused on a host, offered in a container', async () => {
  const { containerRefusal } = await import('./offer.js');
  const { OpencodeRuntime } = await import('./runtimes/opencode.js');
  const { CopilotRuntime } = await import('./runtimes/copilot.js');
  const { CodexRuntime } = await import('./runtimes/codex.js');
  const { ClaudeCodeRuntime } = await import('./runtimes/claude-code.js');
  for (const r of [new OpencodeRuntime(), new CopilotRuntime(), new CodexRuntime({ sandbox: 'off' })]) {
    assert.equal(containerRefusal(r.capabilities, false), 'needs the containerised worker', `${r.kind} on a host`);
    assert.equal(containerRefusal(r.capabilities, true), null, `${r.kind} in a container`);
  }
  // Claude's hooks and Codex's own sandbox confine writes, so they run on a host too.
  for (const r of [new ClaudeCodeRuntime(), new CodexRuntime({ sandbox: 'workspace-write' })]) {
    assert.equal(containerRefusal(r.capabilities, false), null, `${r.kind} on a host`);
  }
});
