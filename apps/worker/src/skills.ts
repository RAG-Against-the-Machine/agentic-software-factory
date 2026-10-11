import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SKILL_ENTRY_FILE, type RunContext, type ThirdPartySkill } from '@asf/shared';

const exec = promisify(execFile);

/** Native skill folders the worker owns are `asf-<id>`, so they never clash with a repo's own. */
const NATIVE_PREFIX = 'asf-';
const EXCLUDE_LINE = '/.claude/skills/asf-*/';

/** The enabled skills given to this role. */
export function skillsForRole(ctx: RunContext, role: string): ThirdPartySkill[] {
  return (ctx.thirdPartySkills ?? []).filter((s) => s.enabled && (s.roles as string[]).includes(role));
}

/** The frontmatter of a SKILL.md and the text after it. No frontmatter = all body. */
export function splitSkillMd(text: string): { name: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { name: null, body: text };
  const name = /^name:\s*(.+?)\s*$/m.exec(m[1])?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
  return { name, body: text.slice(m[0].length) };
}

async function writeSkillFiles(root: string, skill: ThirdPartySkill): Promise<string[]> {
  const dir = resolve(root);
  const paths: string[] = [];
  for (const f of skill.files) {
    // The schema already refuses absolute paths and "..", this is belt and braces.
    const path = resolve(dir, f.path);
    if (!path.startsWith(dir + '/')) throw new Error(`refusing skill file path "${f.path}" in ${skill.id}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.content, 'utf8');
    paths.push(path);
  }
  return paths;
}

/** The names the repo's own skills go by: their folder names and their SKILL.md `name:`. */
async function repoSkillNames(skillsDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(NATIVE_PREFIX)) continue;
    names.add(e.name);
    const md = await readFile(join(skillsDir, e.name, SKILL_ENTRY_FILE), 'utf8').catch(() => null);
    const name = md === null ? null : splitSkillMd(md).name;
    if (name) names.add(name);
  }
  return names;
}

/** Add the asf-* pattern to the repo's info/exclude once, so the skills are never committed or audited. */
async function excludeNativeSkills(cwd: string): Promise<void> {
  const rel = (await exec('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd })).stdout.trim();
  const path = resolve(cwd, rel);
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`, 'utf8');
}

/**
 * Put skills where a runtime that loadsSkillFiles finds them: `<cwd>/.claude/skills/asf-<id>/`.
 * Earlier asf-* folders are cleared first (a reused worktree may hold another role's skills).
 * A skill whose name the repo already uses for its own skill is skipped: the repo's wins.
 */
export async function installNativeSkills(cwd: string, skills: ThirdPartySkill[], isGitRepo: boolean): Promise<{ installed: string[]; skipped: string[] }> {
  const skillsDir = join(cwd, '.claude', 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(NATIVE_PREFIX)) await rm(join(skillsDir, e.name), { recursive: true, force: true });
  }
  const installed: string[] = [];
  const skipped: string[] = [];
  if (!skills.length) return { installed, skipped };
  const taken = await repoSkillNames(skillsDir);
  for (const s of skills) {
    if (taken.has(s.name)) { skipped.push(s.id); continue; }
    await writeSkillFiles(join(skillsDir, NATIVE_PREFIX + s.id), s);
    installed.push(s.id);
  }
  if (isGitRepo && installed.length) await excludeNativeSkills(cwd);
  return { installed, skipped };
}

export interface FallbackSkill { skill: ThirdPartySkill; dir: string; paths: string[] }

/** Write skills under `<runDir>/skills/<id>/` for a runtime that doesn't load skill folders. */
export async function writeFallbackSkills(runDir: string, skills: ThirdPartySkill[]): Promise<FallbackSkill[]> {
  const out: FallbackSkill[] = [];
  for (const s of skills) {
    const dir = resolve(runDir, 'skills', s.id);
    await rm(dir, { recursive: true, force: true });
    out.push({ skill: s, dir, paths: await writeSkillFiles(dir, s) });
  }
  return out;
}
