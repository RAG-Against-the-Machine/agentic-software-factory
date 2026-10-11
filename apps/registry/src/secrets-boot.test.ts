import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { dbAvailable, TEST_URL } from './test/harness.js';
import { migrate, MIGRATIONS_DIR } from './db/migrate.js';

const skip = !(await dbAvailable());

/**
 * #9 end to end through a real registry process: boot encrypts what an older
 * release stored in plaintext, /health reports the at-rest state for doctor,
 * the RPC hands the api the plaintext, and a wrong key is a loud 409 —
 * never an empty token.
 */
test('registry boot encrypts saved tokens; /health + RPC report and enforce the key', { skip }, async () => {
  const schema = `t_secboot_${Date.now().toString(36)}`;
  const admin = postgres(TEST_URL, { onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const db = postgres(TEST_URL, { onnotice: () => {}, connection: { search_path: schema } });
  await migrate(db, MIGRATIONS_DIR);
  await db`INSERT INTO org_secret (name, value, updated_by) VALUES ('GITHUB_TOKEN', 'ghp_from_old_release', 'ada')`;

  const key = randomBytes(32).toString('hex');
  process.env.ASF_SECRET_KEY = key;
  const { buildServer } = await import('./server.js');
  const { app, secret } = await buildServer({ secret: 's3cret', migrate: true, sweeper: false, recurring: false, databaseUrl: TEST_URL, schema });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const rpc = (body: object) => fetch(`${base}/internal/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-run-secret': secret }, body: JSON.stringify(body) });
  try {
    const [row] = await db<{ value: string }[]>`SELECT value FROM org_secret WHERE name = 'GITHUB_TOKEN'`;
    assert.ok(row.value.startsWith('enc:v1:') && !row.value.includes('ghp_from_old_release'), 'boot encrypted the legacy row');

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.secrets.state, 'encrypted');
    assert.match(health.secrets.keyId, /^[0-9a-f]{8}$/);
    assert.ok(!JSON.stringify(health).includes(key) && !JSON.stringify(health).includes('GITHUB_TOKEN'), '/health carries no key and no names');

    const got = await (await rpc({ op: 'getOrgSecret', name: 'GITHUB_TOKEN' })).json();
    assert.equal(got.result.value, 'ghp_from_old_release');
    assert.equal((await (await rpc({ op: 'putOrgSecret', name: 'OPENAI_API_KEY', value: 'sk-new', by: 'ada' })).json()).ok, true);
    const [o] = await db<{ value: string }[]>`SELECT value FROM org_secret WHERE name = 'OPENAI_API_KEY'`;
    assert.ok(o.value.startsWith('enc:v1:'), 'a token saved through the RPC lands encrypted');

    // Wrong key (e.g. a restore onto a host with a fresh .env): loud, specific, not "unset".
    process.env.ASF_SECRET_KEY = randomBytes(32).toString('hex');
    const bad = await rpc({ op: 'getOrgSecret', name: 'GITHUB_TOKEN' });
    assert.equal(bad.status, 409);
    const badJson = await bad.json();
    assert.equal(badJson.error, 'secret_key_error');
    assert.match(badJson.reason, /GITHUB_TOKEN was encrypted with key/);
    const h2 = await (await fetch(`${base}/health`)).json();
    assert.equal(h2.ok, true, 'the registry keeps serving runs');
    assert.equal(h2.secrets.state, 'key-mismatch');
    assert.equal(h2.secrets.undecryptable, 2);
  } finally {
    await app.close();
    delete process.env.ASF_SECRET_KEY;
  }

  // A malformed key stops the boot with a clear reason.
  process.env.ASF_SECRET_KEY = 'not-a-valid-key!';
  try {
    await assert.rejects(buildServer({ secret: 's', migrate: false, sweeper: false, recurring: false, databaseUrl: TEST_URL, schema }), /ASF_SECRET_KEY must be/);
  } finally {
    delete process.env.ASF_SECRET_KEY;
    const { closePool } = await import('./db/pool.js');
    await closePool();
    await db.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
