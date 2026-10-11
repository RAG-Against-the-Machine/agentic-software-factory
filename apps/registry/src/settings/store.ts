import type { OrgValues, SettingKey } from '@asf/shared';
import { SETTINGS, SettingError, orgSettableKeys } from '@asf/shared';
import type { Sql } from '../db/pool.js';

export async function getOrgSettings(sql: Sql): Promise<OrgValues> {
  const rows = await sql`SELECT key, value FROM org_setting`;
  const out: OrgValues = {};
  for (const r of rows) (out as Record<string, unknown>)[String(r.key)] = r.value;
  return out;
}

export async function putOrgSetting(sql: Sql, key: string, value: unknown, by: string | null): Promise<void> {
  if (!(key in SETTINGS)) throw new SettingError(`unknown setting ${key}`);
  if (!orgSettableKeys().includes(key as SettingKey)) throw new SettingError(`${key} is deploy-time configuration and cannot be set from the UI`);
  await sql`INSERT INTO org_setting (key, value, updated_by, updated_at) VALUES (${key}, ${sql.json(value as never)}, ${by}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function deleteOrgSetting(sql: Sql, key: string): Promise<void> {
  await sql`DELETE FROM org_setting WHERE key = ${key}`;
}
