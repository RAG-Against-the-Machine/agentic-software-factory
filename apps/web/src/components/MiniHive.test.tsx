import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CLASSIC_THEME, HIVE_THEME, type ActiveThemeWire, type ThemeSlot } from '@asf/shared/ui';
import type { RunningRunWire } from '@asf/shared';
import { MiniHive, miniHiveLine } from './MiniHive';

const ALL: ThemeSlot[] = ['orchestrator', 'planner', 'implementer', 'tester', 'reviewer'];
const hive: ActiveThemeWire = { manifest: HIVE_THEME, builtIn: true, requested: null,
  images: Object.fromEntries(ALL.map((s) => [s, { url: `/api/themes/hive/images/${s}?v=1`, version: '1' }])) };
const classic: ActiveThemeWire = { manifest: CLASSIC_THEME, builtIn: true, images: {}, requested: null };
const render = (active: ActiveThemeWire, run: Pick<RunningRunWire, 'state' | 'activeRole' | 'activeSince' | 'roleStates'>) => {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], active);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><MiniHive run={run} /></QueryClientProvider>);
};
const building = { state: 'running', activeRole: 'implementer', activeSince: '2026-10-04T10:00:00Z',
  roleStates: { planner: 'done', implementer: 'running', tester: 'pending', reviewer: 'pending' } } as const;

test('the line reads who is doing what, in the theme\'s words', () => {
  assert.equal(miniHiveLine(HIVE_THEME, 'implementer'), 'Builder is writing code');
  assert.equal(miniHiveLine(HIVE_THEME, 'planner'), 'Scout is planning');
  assert.equal(miniHiveLine(HIVE_THEME, 'publish:push_open'), 'The Queen is delivering');
  assert.equal(miniHiveLine(HIVE_THEME, null), 'The Queen is lining up the next step');
  assert.equal(miniHiveLine(CLASSIC_THEME, 'implementer'), 'Writing code');
  assert.equal(miniHiveLine(CLASSIC_THEME, 'tester'), 'Testing');
});

test('the Hive strip: Queen first, the Builder live and ringed, the Scout grey, the rest faded', () => {
  const html = render(hive, building);
  const members = [...html.matchAll(/class="(mini-member[^"]*)" title="([^"]+)"/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(members, [
    ['The Queen', 'mini-member lead'],
    ['Scout', 'mini-member st-done'],
    ['Builder', 'mini-member on st-running'],
    ['Guard', 'mini-member st-pending'],
    ['Inspector', 'mini-member st-pending'],
  ]);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/api/themes/hive/images/implementer?v=1']);
  assert.equal((html.match(/<canvas/g) ?? []).length, 4);
  assert.match(html, />Builder is writing code</);
});

test('classic with no uploads shows the strip with its built-in placeholders', () => {
  const html = render(classic, building);
  assert.equal((html.match(/class="mini-member/g) ?? []).length, 5);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/themes/classic/implementer.svg']);
  assert.match(html, />Writing code</);
});

test('the Hive with no pictures keeps the running dot, with the stage spelled out', () => {
  const html = render({ ...hive, images: {} }, building);
  assert.match(html, /<span class="dot running"><\/span>Builder is writing code/);
  assert.doesNotMatch(html, /mini-member/);
});

test('an older api with no crew fields still renders', () => {
  const html = render(hive, { state: 'running' } as never);
  assert.match(html, /The Queen is lining up the next step/);
  assert.match(html, /class="mini-member on lead" title="The Queen"/);
});

// --- M13: state pictures ---

test('M13: the strip shows each member in its state picture; only the one with the work moves', () => {
  const STATES = ['idle', 'working', 'done'] as const;
  const loops: ActiveThemeWire = { ...hive,
    stateImages: Object.fromEntries(ALL.map((s) => [s, Object.fromEntries(STATES.map((st) => [st, { url: `/api/themes/hive/images/${s}/${st}?v=1`, version: '1' }]))])) };
  const html = render(loops, building);
  const pics = [...html.matchAll(/title="([^"]+)" data-picture="([a-z]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pics, [['The Queen', 'idle'], ['Scout', 'done'], ['Builder', 'working'], ['Guard', 'idle'], ['Inspector', 'idle']]);
  assert.deepEqual([...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]), ['/api/themes/hive/images/implementer/working?v=1']);
  assert.equal((html.match(/<canvas/g) ?? []).length, 4);
  assert.match(html, /class="mini-member st-done own-states"/);
});
