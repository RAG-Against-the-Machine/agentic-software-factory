import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderSecret } from './secrets.js';

/**
 * resolveProviderSecret resolves a UI-entered secret at provider-build time: an
 * org pointer secret://org/<KEY> is fetched from the org_secret sink via the
 * registry; a plain value passes through. We stub global.fetch to answer the
 * getOrgSecret RPC.
 */
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function stubGetOrgSecret(map: Record<string, string | null>): string[] {
  const asked: string[] = [];
  global.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { op: string; name?: string };
    if (body.op !== 'getOrgSecret') throw new Error(`unexpected op ${body.op}`);
    asked.push(body.name!);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { value: map[body.name!] ?? null } }) };
  }) as unknown as typeof fetch;
  return asked;
}

test('resolves secret://org/<KEY> through the registry sink', async () => {
  const asked = stubGetOrgSecret({ JIRA_API_TOKEN: 'tok-live' });
  const out = await resolveProviderSecret('secret://org/JIRA_API_TOKEN');
  assert.equal(out, 'tok-live');
  assert.deepEqual(asked, ['JIRA_API_TOKEN'], 'the org/ prefix is stripped before the lookup');
});

test('a plain (non-pointer) value passes through, no registry call', async () => {
  let called = false;
  global.fetch = (async () => { called = true; throw new Error('should not fetch'); }) as unknown as typeof fetch;
  assert.equal(await resolveProviderSecret('ghp_literal'), 'ghp_literal');
  assert.equal(await resolveProviderSecret(''), '');
  assert.equal(called, false);
});

test('a pointer to an unset org secret fails loud', async () => {
  stubGetOrgSecret({});
  await assert.rejects(() => resolveProviderSecret('secret://org/MISSING'), /org secret store/);
});
