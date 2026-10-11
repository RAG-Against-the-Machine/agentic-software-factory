import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext, ThirdPartySkill } from '@asf/shared';
import { skillsForRole, installNativeSkills, writeFallbackSkills, splitSkillMd } from './skills.js';
import { auditWorktree } from './guard.js';

const exec = promisify(execFile);
const dirs: string[] = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asf-skills-'));
  dirs.push(dir);
  return dir;
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await tmp();
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  for (const [p, c] of Object.entries({ 'README.md': 'hi\n', ...files })) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const porcelain = async (dir: string) => (await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir })).stdout.trim();
const exists = (p: string) => stat(p).then(() => true, () => false);

function skill(id: string, over: Partial<ThirdPartySkill> = {}): ThirdPartySkill {
  return {
    id, name: id, description: `does ${id}`, sourceUrl: 'https://github.com/o/r', sourceRef: 'main', commitSha: 'abcdef1',
    files: [
      { path: 'SKILL.md', content: `---\nname: ${over.name ?? id}\ndescription: does ${id}\n---\n# ${id}\n\nRead reference/notes.md.\n` },
      { path: 'reference/notes.md', content: 'notes' },
    ],
    enabled: true, roles: ['implementer'], addedBy: null, updatedAt: '2026-01-01T00:00:00Z', ...over,
  };
}
const ctxWith = (skills: ThirdPartySkill[]) => ({ thirdPartySkills: skills }) as unknown as RunContext;

test('skillsForRole keeps the enabled skills given to the role', () => {
  const ctx = ctxWith([skill('a-one'), skill('b-two', { roles: ['reviewer', 'implementer'] }), skill('c-three', { roles: ['tester'] }), skill('d-four', { enabled: false })]);
  assert.deepEqual(skillsForRole(ctx, 'implementer').map((s) => s.id), ['a-one', 'b-two']);
  assert.deepEqual(skillsForRole(ctx, 'tester').map((s) => s.id), ['c-three']);
  assert.deepEqual(skillsForRole(ctx, 'planner'), []);
  assert.deepEqual(skillsForRole({} as RunContext, 'planner'), []);
});

test('splitSkillMd reads the frontmatter name and returns the body', () => {
  assert.deepEqual(splitSkillMd('---\nname: "pdf"\ndescription: x\n---\nbody\n'), { name: 'pdf', body: 'body\n' });
  assert.deepEqual(splitSkillMd('just body'), { name: null, body: 'just body' });
});

test('native skills are written as asf-<id> folders and leave git status and the scope audit clean', async () => {
  const repo = await repoWith({});
  const got = await installNativeSkills(repo, [skill('pdf-tools')], true);
  assert.deepEqual(got, { installed: ['pdf-tools'], skipped: [] });
  assert.match(await readFile(join(repo, '.claude/skills/asf-pdf-tools/SKILL.md'), 'utf8'), /name: pdf-tools/);
  assert.equal(await readFile(join(repo, '.claude/skills/asf-pdf-tools/reference/notes.md'), 'utf8'), 'notes');
  assert.equal(await porcelain(repo), '');
  // A second install doesn't add the exclude line twice.
  await installNativeSkills(repo, [skill('pdf-tools')], true);
  const exclude = await readFile(join(repo, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '/.claude/skills/asf-*/').length, 1);
  const audit = await auditWorktree({ worktreePath: repo }, false);
  assert.deepEqual(audit, { violated: false, paths: [], untracked: [] });
});

test("a repo's own skill wins over an ASF skill of the same name", async () => {
  const repo = await repoWith({
    '.claude/skills/pdf-tools/SKILL.md': '---\nname: pdf-tools\n---\nours\n',
    '.claude/skills/other-dir/SKILL.md': '---\nname: csv-tools\n---\nours too\n',
  });
  const got = await installNativeSkills(repo, [skill('pdf-tools'), skill('csv-kit', { name: 'csv-tools' }), skill('md-tools')], true);
  assert.deepEqual(got, { installed: ['md-tools'], skipped: ['pdf-tools', 'csv-kit'] });
  assert.equal(await readFile(join(repo, '.claude/skills/pdf-tools/SKILL.md'), 'utf8'), '---\nname: pdf-tools\n---\nours\n');
  assert.ok(!(await exists(join(repo, '.claude/skills/asf-pdf-tools'))));
  assert.ok(!(await exists(join(repo, '.claude/skills/asf-csv-kit'))));
  assert.equal(await porcelain(repo), '');
});

test("stale asf-* folders from another role are removed, the repo's own skills are not", async () => {
  const repo = await repoWith({ '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\nx\n' });
  await installNativeSkills(repo, [skill('old-one')], true);
  assert.ok(await exists(join(repo, '.claude/skills/asf-old-one')));
  await installNativeSkills(repo, [skill('new-one')], true);
  assert.ok(!(await exists(join(repo, '.claude/skills/asf-old-one'))));
  assert.ok(await exists(join(repo, '.claude/skills/asf-new-one/SKILL.md')));
  await installNativeSkills(repo, [], true);
  assert.ok(!(await exists(join(repo, '.claude/skills/asf-new-one'))));
  assert.ok(await exists(join(repo, '.claude/skills/mine/SKILL.md')));
});

test('fallback skills are written under <runDir>/skills/<id>/ and their paths returned', async () => {
  const runDir = await tmp();
  const [got] = await writeFallbackSkills(runDir, [skill('pdf-tools')]);
  assert.equal(got.dir, join(runDir, 'skills', 'pdf-tools'));
  assert.deepEqual(got.paths, [join(runDir, 'skills/pdf-tools/SKILL.md'), join(runDir, 'skills/pdf-tools/reference/notes.md')]);
  assert.equal(await readFile(got.paths[1], 'utf8'), 'notes');
});
