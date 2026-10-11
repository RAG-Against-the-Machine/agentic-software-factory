import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSkillUrl, refusal, shortSha, skillEntryText, toggleRole } from './skills-view';

test('checkSkillUrl accepts GitHub and GitLab folder links, trimmed', () => {
  for (const url of [
    'https://github.com/owner/repo/tree/main/skills/my-skill',
    'https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md',
    'https://gitlab.com/group/project/-/tree/main/skills/my-skill',
    'https://gitlab.example.com/group/sub/project/-/tree/v1/skill',
  ]) assert.deepEqual(checkSkillUrl(`  ${url}\n`), { ok: true, url });
});

test('checkSkillUrl refuses with a reason', () => {
  for (const url of [
    '',
    '   ',
    'not a url',
    'http://github.com/owner/repo/tree/main/skill',
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/issues/1',
    'https://gitlab.com/group/project',
    'https://example.com/some/page',
  ]) {
    const got = checkSkillUrl(url);
    assert.equal(got.ok, false, url);
    if (!got.ok) assert.ok(got.reason.length > 0);
  }
});

test('toggleRole adds and removes in SKILL_ROLES order', () => {
  assert.deepEqual(toggleRole(['reviewer'], 'planner'), ['planner', 'reviewer']);
  assert.deepEqual(toggleRole(['tester', 'implementer'], 'reviewer'), ['implementer', 'tester', 'reviewer']);
  assert.deepEqual(toggleRole(['planner', 'tester', 'reviewer'], 'tester'), ['planner', 'reviewer']);
});

test('toggleRole will not remove the last role', () => {
  assert.deepEqual(toggleRole(['tester'], 'tester'), ['tester']);
});

test('shortSha', () => {
  assert.equal(shortSha('abc1234def5678'), 'abc1234');
  assert.equal(shortSha('abc'), 'abc');
});

test('skillEntryText finds SKILL.md', () => {
  assert.equal(skillEntryText([{ path: 'notes.md', content: 'x' }, { path: 'SKILL.md', content: '# Hi' }]), '# Hi');
  assert.equal(skillEntryText([{ path: 'sub/SKILL.md', content: 'nested' }]), '');
  assert.equal(skillEntryText([]), '');
});

test('refusal uses the reason, else a fallback with the status', () => {
  assert.equal(refusal({ status: 409, body: { reason: 'There is already a skill "x".' } }), 'There is already a skill "x".');
  assert.equal(refusal({ status: 500, body: {} }), 'That didn’t work (500).');
  assert.equal(refusal({ status: 502, body: { reason: '  ' } }), 'That didn’t work (502).');
});
