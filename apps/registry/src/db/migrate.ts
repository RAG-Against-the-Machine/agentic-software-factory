import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** db/migrations at the repo root, resolved from this file. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
import type { Sql } from './pool.js';

/**
 * Applies db/migrations/*.sql in filename order, once each, inside a
 * transaction, and records a checksum. A shipped migration that changes on
 * disk is refused by name: the rule is additive-only, and this is where it is
 * enforced rather than remembered.
 */
export class MigrationTamperedError extends Error {
  constructor(public readonly file: string) {
    super(`migration ${file} has changed since it was applied; add a new file instead`);
  }
}

export async function migrate(sql: Sql, dir: string): Promise<{ applied: string[]; total: number }> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Map<string, string>();
  for (const row of await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migration`) {
    done.set(row.name, row.checksum);
  }
  const applied: string[] = [];
  for (const file of files) {
    const body = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    const prior = done.get(file);
    if (prior !== undefined) {
      if (prior !== checksum) throw new MigrationTamperedError(file);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migration (name, checksum) VALUES (${file}, ${checksum})`;
    });
    applied.push(file);
  }
  return { applied, total: files.length };
}
