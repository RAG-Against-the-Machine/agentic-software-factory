import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate, MigrationTamperedError } from './migrate.js';
import { dbAvailable, testDb, tmpMigrationsDir } from '../test/harness.js';

// testDb() applies the REAL db/migrations/*.sql into a fresh schema, so a table
// that a shipped migration creates must exist right after setup.

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('migrate'); });
after(async () => { if (db) await db.close(); });

test('applies once, is idempotent, and refuses a tampered file', { skip }, async () => {
  const dir = await tmpMigrationsDir({ '900_a.sql': 'CREATE TABLE t_a (id int);', '901_b.sql': 'CREATE TABLE t_b (id int);' });
  const first = await migrate(db.sql, dir);
  assert.deepEqual(first.applied, ['900_a.sql', '901_b.sql']);
  const second = await migrate(db.sql, dir);
  assert.deepEqual(second.applied, []);
  await writeFile(join(dir, '900_a.sql'), 'CREATE TABLE t_a (id int, extra text);');
  await assert.rejects(() => migrate(db.sql, dir), (e: unknown) => e instanceof MigrationTamperedError && e.file === '900_a.sql');
});

test('006 creates the org_secret table', { skip }, async () => {
  const [row] = await db.sql<{ exists: boolean }[]>`SELECT to_regclass('org_secret') IS NOT NULL AS exists`;
  assert.equal(row.exists, true);
});
