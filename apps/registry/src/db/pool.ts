import postgres from 'postgres';
import { config } from '../config.js';

export type Sql = postgres.Sql;
/** Either a pooled connection or a transaction handle — the query helpers accept both. */
export type Db = postgres.Sql | postgres.TransactionSql;

let instance: Sql | null = null;

export function sql(opts: { url?: string; schema?: string } = {}): Sql {
  if (!instance) {
    const schema = opts.schema ?? config.databaseSchema;
    instance = postgres(opts.url ?? config.databaseUrl, {
      max: 10,
      idle_timeout: 30,
      onnotice: () => {},
      // Column names only. `postgres.camel` would also rewrite keys inside JSONB
      // values (gates.before_merge -> beforeMerge), which the schemas would reject.
      transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
      ...(schema ? { connection: { search_path: schema } } : {}),
    });
  }
  return instance;
}

export async function ping(): Promise<boolean> {
  try {
    await sql()`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (instance) {
    await instance.end({ timeout: 5 });
    instance = null;
  }
}
