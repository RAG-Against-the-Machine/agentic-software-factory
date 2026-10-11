import { skillInputSchema, skillRolesSchema } from '@asf/shared';
import type { SkillFile, SkillInput, SkillRole, ThirdPartySkill } from '@asf/shared';
import type { Sql } from '../db/pool.js';
import { NotFoundError } from './store.js';

/**
 * Third-party skills. The api fetches a skill's files and parses them; the
 * registry re-checks them (it is the system of record) before it stores them.
 * A replace keeps whether the skill is on and which roles get it.
 */

export class SkillError extends Error { override name = 'SkillError'; }

const at = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

const record = (r: Record<string, unknown>): ThirdPartySkill => ({
  id: String(r.id),
  name: String(r.name),
  description: String(r.description),
  sourceUrl: String(r.sourceUrl),
  sourceRef: String(r.sourceRef),
  commitSha: String(r.commitSha),
  files: r.files as SkillFile[],
  enabled: Boolean(r.enabled),
  roles: r.roles as SkillRole[],
  addedBy: r.addedBy == null ? null : String(r.addedBy),
  updatedAt: at(r.updatedAt).toISOString(),
});

export async function listSkills(sql: Sql): Promise<ThirdPartySkill[]> {
  const rows = await sql`SELECT id, name, description, source_url, source_ref, commit_sha, files, enabled, roles, added_by, updated_at FROM skill ORDER BY id`;
  return rows.map(record);
}

export async function getSkill(sql: Sql, id: string): Promise<ThirdPartySkill | null> {
  const [row] = await sql`SELECT id, name, description, source_url, source_ref, commit_sha, files, enabled, roles, added_by, updated_at FROM skill WHERE id = ${id}`;
  return row ? record(row) : null;
}

/** Create or replace a skill by id. A new skill starts off, for every role. */
export async function putSkill(sql: Sql, skill: SkillInput): Promise<ThirdPartySkill> {
  const parsed = skillInputSchema.safeParse(skill);
  if (!parsed.success) throw new SkillError(`invalid skill: ${parsed.error.issues[0]?.message ?? 'bad skill'}`);
  const s = parsed.data;
  await sql`INSERT INTO skill (id, name, description, source_url, source_ref, commit_sha, files, added_by, updated_at)
    VALUES (${s.id}, ${s.name}, ${s.description}, ${s.sourceUrl}, ${s.sourceRef}, ${s.commitSha}, ${sql.json(s.files as never)}, ${s.addedBy}, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, source_url = EXCLUDED.source_url,
      source_ref = EXCLUDED.source_ref, commit_sha = EXCLUDED.commit_sha, files = EXCLUDED.files,
      added_by = EXCLUDED.added_by, updated_at = EXCLUDED.updated_at`;
  return (await getSkill(sql, s.id))!;
}

/** Turn a skill on or off and, when given, set which roles get it. */
export async function setSkillState(sql: Sql, id: string, enabled: boolean, roles?: SkillRole[]): Promise<ThirdPartySkill> {
  let rows;
  if (roles === undefined) {
    rows = await sql`UPDATE skill SET enabled = ${enabled}, updated_at = clock_timestamp() WHERE id = ${id} RETURNING id`;
  } else {
    const parsed = skillRolesSchema.safeParse(roles);
    if (!parsed.success) throw new SkillError(`invalid roles: ${parsed.error.issues[0]?.message ?? 'bad roles'}`);
    rows = await sql`UPDATE skill SET enabled = ${enabled}, roles = ${parsed.data}::text[], updated_at = clock_timestamp()
      WHERE id = ${id} RETURNING id`;
  }
  if (rows.length === 0) throw new NotFoundError('skill', id);
  return (await getSkill(sql, id))!;
}

export async function deleteSkill(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM skill WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
