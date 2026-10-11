import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CLASSIC_THEME, HIVE_THEME, type ActiveThemeWire, type ThemeSlot } from '@asf/shared/ui';
import { HiveStage, initialOf, stageCaption, type HiveStageProps } from './HiveStage';

const pics = (slots: ThemeSlot[]) => Object.fromEntries(slots.map((s) => [s, { url: `/api/themes/hive/images/${s}?v=1`, version: '1' }]));
const ALL: ThemeSlot[] = ['orchestrator', 'planner', 'implementer', 'tester', 'reviewer'];

/** Render the stage with a given active theme already in the react-query cache (no fetch). */
function render(active: ActiveThemeWire, props: HiveStageProps): string {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], active);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><HiveStage {...props} /></QueryClientProvider>);
}
const hive = (slots = ALL): ActiveThemeWire => ({ manifest: HIVE_THEME, builtIn: true, images: pics(slots), requested: null });
const classic: ActiveThemeWire = { manifest: CLASSIC_THEME, builtIn: true, images: {}, requested: null };
/** The Hive with 3D state loops: every member has idle, working and done (M13). */
const STATES = ['idle', 'working', 'done'] as const;
const loops: ActiveThemeWire = {
  manifest: HIVE_THEME, builtIn: true, requested: null,
  images: Object.fromEntries(ALL.map((s) => [s, { url: `/api/themes/hive/images/${s}/idle?v=1`, version: '1' }])),
  stateImages: Object.fromEntries(ALL.map((s) => [s, Object.fromEntries(STATES.map((st) => [st, { url: `/api/themes/hive/images/${s}/${st}?v=1`, version: '1' }]))])),
};
const picOf = (html: string, slot: string) => html.match(new RegExp(`data-slot="${slot}" data-picture="([a-z]+)"`))?.[1];
const working: HiveStageProps = {
  run: { state: 'running' },
  tasks: [
    { role: 'planner', state: 'done', seq: 0, startedAt: '2026-10-04T11:00:00Z' },
    { role: 'implementer', state: 'running', seq: 1, startedAt: '2026-10-04T11:01:00Z' },
    { role: 'tester', state: 'pending', seq: 2, startedAt: null },
    { role: 'reviewer', state: 'pending', seq: 3, startedAt: null },
  ],
};

test('the Hive: the Queen in the middle of the arc, the Builder in the spotlight, the Scout greyed', () => {
  const html = render(hive(), working);
  const order = [...html.matchAll(/data-slot="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['planner', 'implementer', 'orchestrator', 'tester', 'reviewer']);
  assert.match(html, /class="hive-member on st-running" data-slot="implementer"/);
  assert.match(html, /class="hive-member st-done" data-slot="planner"/);
  assert.match(html, /class="hive-member st-pending" data-slot="tester"/);
  assert.match(html, /class="hive-member lead" data-slot="orchestrator"/);
  for (const n of ['The Queen', 'Scout', 'Builder', 'Guard', 'Inspector']) assert.ok(html.includes(`>${n}<`), n);
  assert.match(html, /class="hive-stage mood-working"/);
});

test('only the member in the spotlight is a live <img>; the rest are still canvases', () => {
  const html = render(hive(), working);
  const imgs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imgs, ['/api/themes/hive/images/implementer?v=1']);
  assert.equal((html.match(/<canvas/g) ?? []).length, 4);
});

test('a member with no picture shows its initial', () => {
  const html = render(hive(['orchestrator', 'planner']), working);
  assert.match(html, /<span class="hive-img hive-initial" aria-hidden="true">B<\/span>/);
  assert.equal(initialOf('The Queen'), 'Q');
  assert.equal(initialOf('inspector'), 'I');
});

test('classic with no uploads shows the full stage with its built-in placeholders', () => {
  const html = render(classic, working);
  assert.match(html, /class="hive-stage mood-working"/);
  const order = [...html.matchAll(/data-slot="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['planner', 'implementer', 'orchestrator', 'tester', 'reviewer']);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/themes/classic/implementer.svg']);
  assert.equal((html.match(/<canvas/g) ?? []).length, 4);
  assert.match(html, new RegExp(CLASSIC_THEME.quips!.implementer![0]));
});

test('classic: an uploaded picture beats the placeholder', () => {
  const html = render({ ...classic, images: { implementer: { url: '/api/themes/classic/images/implementer?v=1', version: '1' } } }, working);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/api/themes/classic/images/implementer?v=1']);
});

test('the Hive with no pictures is a quiet caption line', () => {
  const html = render(hive([]), working);
  assert.match(html, /^<div class="hive-quiet mood-working">/);
  assert.doesNotMatch(html, /hive-member|<img|<canvas/);
  assert.match(html, new RegExp(HIVE_THEME.quips!.implementer![0]));
});

test('the gate puts the Queen in the spotlight with her line, announced politely', () => {
  const html = render(hive(), { ...working, run: { state: 'awaiting_checkpoint' }, gates: [{ state: 'open' }] });
  assert.match(html, /class="hive-member lead on" data-slot="orchestrator"/);
  assert.match(html, /<span class="sr-only" aria-live="polite">The Queen awaits your word<\/span>/);
});

test('a stopped job keeps everyone still, the Queen included', () => {
  const html = render(hive(), { ...working, run: { state: 'failed' } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /mood-failed/);
  assert.match(html, /The Queen has called the hive home/);
});

test('captions: quips while working, mood lines otherwise, all text (no markup)', () => {
  assert.equal(stageCaption(HIVE_THEME, 'working', 'implementer', 0), `${HIVE_THEME.quips!.implementer![0]}…`);
  assert.equal(stageCaption(HIVE_THEME, 'question', 'planner', 0), 'Scout flew back with a question for you');
  assert.equal(stageCaption(CLASSIC_THEME, 'handoff', 'tester', 0), 'Handing over to the Tester');
  const sneaky = { ...HIVE_THEME, members: { ...HIVE_THEME.members, implementer: { name: '<img src=x onerror=alert(1)>' } } };
  const html = render({ ...hive(), manifest: sneaky }, working);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// --- M13: state pictures ---

test('M13: with state loops each member shows its state and every one plays: Scout done, Builder working, the rest idle', () => {
  const html = render(loops, working);
  assert.deepEqual(['planner', 'implementer', 'orchestrator', 'tester', 'reviewer'].map((s) => picOf(html, s)), ['done', 'working', 'idle', 'idle', 'idle']);
  const imgs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imgs, [
    '/api/themes/hive/images/implementer/working?v=1', '/api/themes/hive/images/orchestrator/idle?v=1',
    '/api/themes/hive/images/planner/done?v=1', '/api/themes/hive/images/reviewer/idle?v=1', '/api/themes/hive/images/tester/idle?v=1',
  ]);
  assert.doesNotMatch(html, /<canvas/);
  // The state is in the picture, so no grey or fade; shown whole on white.
  assert.match(html, /class="hive-member st-done own-states" data-slot="planner"/);
  assert.equal((html.match(/class="hive-img whole"/g) ?? []).length, 5);
});

test('M13: at a check-in the Queen works; delivered she is done; a stopped job is still and nobody works', () => {
  const gate = render(loops, { ...working, run: { state: 'awaiting_checkpoint' }, gates: [{ state: 'open' }] });
  assert.equal(picOf(gate, 'orchestrator'), 'working');
  const delivered = render(loops, { run: { state: 'succeeded' }, tasks: working.tasks.map((t) => ({ ...t, state: 'done' })) });
  assert.deepEqual(['orchestrator', 'planner', 'reviewer'].map((s) => picOf(delivered, s)), ['done', 'done', 'done']);
  const stopped = render(loops, { ...working, run: { state: 'failed' } });
  assert.equal(picOf(stopped, 'implementer'), 'idle');
  assert.equal(picOf(stopped, 'planner'), 'done');
  assert.doesNotMatch(stopped, /<img/, 'a stopped job keeps everyone still');
});

test('M13: a member with only a plain picture keeps the M12 behaviour beside members with loops', () => {
  const mixed: ActiveThemeWire = { ...loops, stateImages: { ...loops.stateImages, tester: { any: { url: '/api/themes/hive/images/tester?v=1', version: '1' } } } };
  const html = render(mixed, working);
  assert.match(html, /class="hive-member st-pending" data-slot="tester"/, 'faded, no own-states');
  assert.equal((html.match(/<canvas/g) ?? []).length, 1, 'the plain-picture member is still');
});
