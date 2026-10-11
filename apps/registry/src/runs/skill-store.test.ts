import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rpcRequestSchema, SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES, type SkillInput, type SkillRole } from '@asf/shared';
import { rpcHandlers } from '../routes/rpc.js';
import { putSkill, setSkillState, SkillError } from './skill-store.js';
import { NotFoundError } from './store.js';
import { dbAvailable, testDb } from '../test/harness.js';

let db: Awaited<ReturnType<typeof testDb>>;
const skip = !(await dbAvailable());
before(async () => { if (!skip) db = await testDb('skill'); });
after(async () => { if (db) await db.close(); });

const pdf: SkillInput = {
  id: 'pdf-tools', name: 'pdf-tools', description: 'Work with PDFs',
  sourceUrl: 'https://github.com/acme/skills/tree/main/pdf-tools', sourceRef: 'main', commitSha: 'a1b2c3d',
  files: [{ path: 'SKILL.md', content: '---\nname: pdf-tools\n---\nHello' }, { path: 'ref/forms.md', content: 'forms' }],
  addedBy: 'ana',
};

test('a skill round-trips, starts off for every role, and a replace keeps its state', { skip }, async () => {
  const h = rpcHandlers(db.sql);
  assert.deepEqual((await h.listSkills({ op: 'listSkills' })).skills, []);

  const put = (await h.putSkill({ op: 'putSkill', skill: pdf })).skill;
  assert.equal(put.enabled, false);
  assert.deepEqual(put.roles, ['planner', 'implementer', 'tester', 'reviewer']);
  assert.deepEqual(put.files, pdf.files);
  assert.equal(put.addedBy, 'ana');
  assert.equal((await h.getSkill({ op: 'getSkill', id: 'pdf-tools' })).skill?.commitSha, 'a1b2c3d');
  assert.equal((await h.getSkill({ op: 'getSkill', id: 'nobody' })).skill, null);

  const on = (await h.setSkillState({ op: 'setSkillState', id: 'pdf-tools', enabled: true, roles: ['implementer', 'tester'] })).skill;
  assert.equal(on.enabled, true);
  assert.deepEqual(on.roles, ['implementer', 'tester']);

  const replaced = (await h.putSkill({ op: 'putSkill', skill: { ...pdf, commitSha: 'b2c3d4e', files: [{ path: 'SKILL.md', content: 'v2' }] } })).skill;
  assert.equal(replaced.commitSha, 'b2c3d4e');
  assert.deepEqual(replaced.files, [{ path: 'SKILL.md', content: 'v2' }]);
  assert.equal(replaced.enabled, true, 'a replace keeps enabled');
  assert.deepEqual(replaced.roles, ['implementer', 'tester'], 'a replace keeps roles');

  const off = (await h.setSkillState({ op: 'setSkillState', id: 'pdf-tools', enabled: false })).skill;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.roles, ['implementer', 'tester'], 'no roles keeps the ones it has');

  await h.putSkill({ op: 'putSkill', skill: { ...pdf, id: 'csv-tools', name: 'csv-tools' } });
  assert.deepEqual((await h.listSkills({ op: 'listSkills' })).skills.map((s) => s.id), ['csv-tools', 'pdf-tools']);

  assert.deepEqual(await h.deleteSkill({ op: 'deleteSkill', id: 'csv-tools' }), { deleted: true });
  assert.deepEqual(await h.deleteSkill({ op: 'deleteSkill', id: 'csv-tools' }), { deleted: false });
  assert.deepEqual((await h.listSkills({ op: 'listSkills' })).skills.map((s) => s.id), ['pdf-tools']);
});

test('setSkillState validates roles and 404s an unknown skill', { skip }, async () => {
  await putSkill(db.sql, { ...pdf, id: 'roles-check' });
  await assert.rejects(setSkillState(db.sql, 'roles-check', true, ['orchestrator' as SkillRole]), SkillError);
  await assert.rejects(setSkillState(db.sql, 'roles-check', true, []), SkillError);
  await assert.rejects(setSkillState(db.sql, 'roles-check', true, ['planner', 'planner']), SkillError);
  await assert.rejects(setSkillState(db.sql, 'nobody', true), NotFoundError);
  assert.equal(rpcRequestSchema.safeParse({ op: 'setSkillState', id: 'roles-check', enabled: true, roles: ['admin'] }).success, false);
});

test('a skill over the limits is refused by the RPC schema and by putSkill', { skip }, async () => {
  const bad: Record<string, SkillInput['files']> = {
    'too many files': Array.from({ length: SKILL_MAX_FILES + 1 }, (_, i) => ({ path: i === 0 ? 'SKILL.md' : `f${i}.md`, content: '' })),
    'too large': [{ path: 'SKILL.md', content: 'x'.repeat(SKILL_MAX_TOTAL_BYTES + 1) }],
    'bad extension': [{ path: 'SKILL.md', content: '' }, { path: 'run.sh', content: 'rm -rf /' }],
    'climbs out': [{ path: 'SKILL.md', content: '' }, { path: '../secrets.md', content: '' }],
    'absolute': [{ path: 'SKILL.md', content: '' }, { path: '/etc/x.md', content: '' }],
    'no SKILL.md': [{ path: 'README.md', content: '' }],
  };
  for (const [why, files] of Object.entries(bad)) {
    const skill = { ...pdf, id: 'bad-skill', files };
    assert.equal(rpcRequestSchema.safeParse({ op: 'putSkill', skill }).success, false, why);
    await assert.rejects(putSkill(db.sql, skill), SkillError, why);
  }
  const h = rpcHandlers(db.sql);
  assert.equal((await h.getSkill({ op: 'getSkill', id: 'bad-skill' })).skill, null);
});
