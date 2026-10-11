import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSecrets, resolveSecret, isSecretRef, secretName, SecretError } from './secrets.js';

test('isSecretRef / secretName recognise the pointer form', () => {
  assert.ok(isSecretRef('secret://GITHUB_TOKEN'));
  assert.ok(!isSecretRef('ghp_literal'));
  assert.ok(!isSecretRef(42));
  assert.equal(secretName('secret://GITHUB_TOKEN'), 'GITHUB_TOKEN');
});

test('env mode: secret://NAME resolves from the environment, non-refs pass through', async () => {
  const cfg = { GITHUB_TOKEN: 'secret://GH', PLAIN: 'literal', N: 5 as unknown };
  const out = await resolveSecrets(cfg, { source: 'env', env: { GH: 'ghp_real' } });
  assert.equal(out.GITHUB_TOKEN, 'ghp_real');
  assert.equal(out.PLAIN, 'literal');
  assert.equal(out.N, 5);
});

test('env mode: an unset env var falls back to treating the name as the literal', async () => {
  const out = await resolveSecret('secret://a-literal-value', { source: 'env', env: {} });
  assert.equal(out, 'a-literal-value');
});

test('file mode: reads SECRETS_DIR/<name>, trimming a trailing newline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'asf-secrets-'));
  await writeFile(path.join(dir, 'DB'), 'postgres://x\n');
  const out = await resolveSecrets({ DATABASE_URL: 'secret://DB' }, { source: 'file', dir });
  assert.equal(out.DATABASE_URL, 'postgres://x');
});

test('file mode: a missing file fails loud, naming the key and the path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'asf-secrets-'));
  await assert.rejects(
    () => resolveSecrets({ DATABASE_URL: 'secret://NOPE' }, { source: 'file', dir }),
    (e: unknown) => e instanceof SecretError && /DATABASE_URL/.test((e as Error).message) && /NOPE/.test((e as Error).message),
  );
});

test('org/ source: secret://org/<KEY> resolves through orgLookup regardless of source', async () => {
  const seen: string[] = [];
  const orgLookup = async (name: string) => { seen.push(name); return name === 'JIRA_API_TOKEN' ? 'tok-live' : null; };
  const out = await resolveSecret('secret://org/JIRA_API_TOKEN', { source: 'env', env: {}, orgLookup });
  assert.equal(out, 'tok-live');
  assert.deepEqual(seen, ['JIRA_API_TOKEN']); // the org/ prefix is stripped before lookup
});

test('org/ source: a non-org secret ref is untouched by orgLookup', async () => {
  let called = false;
  const orgLookup = async () => { called = true; return null; };
  const out = await resolveSecret('secret://GH', { source: 'env', env: { GH: 'ghp_real' }, orgLookup });
  assert.equal(out, 'ghp_real');
  assert.equal(called, false);
});

test('org/ source: an unset org secret throws a clear SecretError', async () => {
  await assert.rejects(
    () => resolveSecret('secret://org/MISSING', { source: 'env', orgLookup: async () => null }),
    (e: unknown) => e instanceof SecretError && /MISSING/.test((e as Error).message) && /org secret store/.test((e as Error).message),
  );
});

test('org/ source: a secret://org/ ref with no lookup configured fails loud', async () => {
  await assert.rejects(
    () => resolveSecret('secret://org/JIRA_API_TOKEN', { source: 'env' }),
    (e: unknown) => e instanceof SecretError && /no org secret lookup/.test((e as Error).message),
  );
});
