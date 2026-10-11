import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIC_THEME, HIVE_THEME, type ThemeManifest } from '@asf/shared/ui';
import { accentOf, appInitialsOf, appTitleOf, backgroundOf, crewName, decorOf, defaultPictureFor, laneLabel, memberName, moodLine, quipFor, textOf } from './theme-view';

const bare: ThemeManifest = { ...CLASSIC_THEME, id: 'bare', name: 'Bare', quips: undefined, moods: undefined, accent: undefined };

test('classic keeps the plain stage labels and says plainly what it is doing', () => {
  assert.equal(crewName(CLASSIC_THEME), 'Team');
  assert.equal(laneLabel(CLASSIC_THEME, 'planner'), 'Plan');
  assert.equal(laneLabel(CLASSIC_THEME, 'implementer'), 'Write code');
  assert.equal(quipFor(CLASSIC_THEME, 'planner', 0), 'Reading the ticket');
  assert.equal(accentOf(CLASSIC_THEME), '#bd93f9');
});

test('default pictures: only the built-in classic theme has placeholders, one per slot', () => {
  assert.equal(defaultPictureFor('classic', true, 'planner'), '/themes/classic/planner.svg');
  assert.equal(defaultPictureFor('classic', true, 'orchestrator'), '/themes/classic/orchestrator.svg');
  assert.equal(defaultPictureFor('classic', false, 'planner'), null);
  assert.equal(defaultPictureFor('hive', true, 'planner'), null);
  assert.equal(defaultPictureFor('robots', false, 'tester'), null);
  assert.equal(defaultPictureFor('classic', true, 'publish:push'), null);
  assert.equal(defaultPictureFor('classic', true, 'decor'), null);
});

test('the Hive puts the bee first: "Builder · Write code"', () => {
  assert.equal(crewName(HIVE_THEME), 'The Hive');
  assert.equal(laneLabel(HIVE_THEME, 'planner'), 'Scout · Plan');
  assert.equal(laneLabel(HIVE_THEME, 'implementer'), 'Builder · Write code');
  assert.equal(laneLabel(HIVE_THEME, 'tester'), 'Guard · Test');
  assert.equal(laneLabel(HIVE_THEME, 'reviewer'), 'Inspector · Review');
  assert.equal(memberName(HIVE_THEME, 'orchestrator'), 'The Queen');
  assert.equal(accentOf(HIVE_THEME), '#e0a526');
});

test('a role that is not a slot keeps its plain label and gets the orchestrator quips', () => {
  assert.equal(memberName(HIVE_THEME, 'publish:push'), null);
  assert.equal(laneLabel(HIVE_THEME, 'publish:push'), 'publish:push');
  assert.ok(HIVE_THEME.quips!.orchestrator!.includes(quipFor(HIVE_THEME, 'publish:push', 3)));
  assert.ok(CLASSIC_THEME.quips!.orchestrator!.includes(quipFor(CLASSIC_THEME, 'nope', 7)));
});

test('quips rotate deterministically and wrap', () => {
  const list = HIVE_THEME.quips!.implementer!;
  assert.equal(quipFor(HIVE_THEME, 'implementer', 0), list[0]);
  assert.equal(quipFor(HIVE_THEME, 'implementer', list.length + 1), list[1]);
  assert.equal(quipFor(HIVE_THEME, 'implementer', 2.7), quipFor(HIVE_THEME, 'implementer', 2));
});

test('a theme that leaves out quips and moods falls back to classic', () => {
  assert.equal(quipFor(bare, 'tester', 0), CLASSIC_THEME.quips!.tester![0]);
  assert.equal(moodLine(bare, 'handoff', { member: 'Implementer' }), 'Handing over to the Implementer');
});

test('mood lines fill the Queen, the bee and the crew', () => {
  assert.equal(moodLine(HIVE_THEME, 'handoff', { member: 'Builder' }, 1), 'The Queen hands the work to Builder');
  assert.equal(moodLine(HIVE_THEME, 'delivered', {}), 'The honey is in! The Hive delivered');
  assert.equal(moodLine(HIVE_THEME, 'gate', {}), 'The Queen awaits your word');
});

test('an accent that is not a plain hex colour never reaches a style', () => {
  for (const accent of ['red', '#fff; background:url(x)', 'url(javascript:x)', '#e0a52']) {
    assert.equal(accentOf({ ...bare, accent }), null, accent);
  }
  assert.equal(accentOf({ ...bare, accent: '#3366CC' }), '#3366CC');
});

test('the app title comes from the theme and falls back to classic', () => {
  assert.equal(appTitleOf(CLASSIC_THEME), 'Agentic Software Factory');
  assert.equal(appTitleOf(HIVE_THEME), 'The Hive Mind');
  assert.equal(appTitleOf({ ...bare, appTitle: undefined }), 'Agentic Software Factory');
  assert.equal(appInitialsOf(CLASSIC_THEME), 'ASF');
  assert.equal(appInitialsOf(HIVE_THEME), 'THM');
});

test('page colours: classic is Dracula, the Hive brings its own, bad hex never reaches a style', () => {
  assert.equal(backgroundOf(CLASSIC_THEME), '#282a36');
  assert.equal(textOf(CLASSIC_THEME), '#f8f8f2');
  assert.equal(backgroundOf(HIVE_THEME), '#1a140c');
  assert.equal(textOf(HIVE_THEME), '#f3e9d2');
  for (const bad of ['black', '#000; color:red', 'url(x)', '#12345']) {
    assert.equal(backgroundOf({ ...bare, background: bad }), null, bad);
    assert.equal(textOf({ ...bare, text: bad }), null, bad);
  }
});

test('decor: the Hive has its honeycomb, classic has none, an unknown pattern never reaches the page', () => {
  assert.equal(decorOf(HIVE_THEME), 'honeycomb');
  assert.equal(decorOf(CLASSIC_THEME), null);
  assert.equal(decorOf({ ...bare, decor: 'stripes' } as unknown as ThemeManifest), null);
});
