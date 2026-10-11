import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CLASSIC_THEME, HIVE_THEME, type ActiveThemeWire, type ThemeSummaryWire } from '@asf/shared/ui';
import { DecorPictureRow, ThemeCard, CrewPicturesSection } from './ThemeSettings';

/** Every element in a rendered tree (host elements only; DecorPictureRow has no child components). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

test('with a picture: a preview and a Remove button', () => {
  const html = renderToStaticMarkup(<DecorPictureRow url="/api/themes/hive/images/decor?v=1" busy={false} onRemove={() => {}} />);
  assert.match(html, /Page decoration/);
  assert.match(html, /<img[^>]*src="\/api\/themes\/hive\/images\/decor\?v=1"/);
  assert.match(html, />Remove<\/button>/);
  assert.doesNotMatch(html, /No picture/);
});

test('without a picture: says how to add one, no Remove', () => {
  const html = renderToStaticMarkup(<DecorPictureRow url={null} busy={false} onRemove={() => {}} />);
  assert.match(html, /No picture/);
  assert.match(html, /decor\.png/);
  assert.doesNotMatch(html, /<img|Remove/);
});

test('the Remove button calls onRemove', () => {
  let calls = 0;
  const tree = DecorPictureRow({ url: '/d.png', busy: false, onRemove: () => { calls++; } });
  const button = elements(tree).find((e) => e.type === 'button');
  assert.ok(button);
  (button.props.onClick as () => void)();
  assert.equal(calls, 1);
});

const summary = (over: Partial<ThemeSummaryWire> = {}): ThemeSummaryWire =>
  ({ id: 'classic', name: 'Classic', description: null, crewName: 'Team', builtIn: true, active: true, images: {}, ...over });

test('ThemeCard: classic with no uploads shows the built-in placeholders', () => {
  const html = renderToStaticMarkup(<ThemeCard t={summary()} on={false} onPick={() => {}} />);
  assert.match(html, /<img[^>]*class="avatar"[^>]*src="\/themes\/classic\/planner\.svg"/);
  assert.match(html, /<img[^>]*class="avatar lead"[^>]*src="\/themes\/classic\/orchestrator\.svg"/);
  assert.doesNotMatch(html, /avatar-empty/);
});

test('ThemeCard: an uploaded theme with no pictures shows empty avatars, not classic placeholders', () => {
  const html = renderToStaticMarkup(<ThemeCard t={summary({ id: 'hive', name: 'The Hive', builtIn: false, active: false })} on={false} onPick={() => {}} />);
  assert.doesNotMatch(html, /themes\/classic/);
  assert.match(html, /avatar-empty/);
});

/** Render CrewPicturesSection with the active theme and theme list already in the react-query cache. */
function renderCrew(active: ActiveThemeWire): string {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], active);
  qc.setQueryData(['themes'], { themes: [summary({ active: true })], slots: [], maxMb: 5, envPinned: false });
  return renderToStaticMarkup(<QueryClientProvider client={qc}><CrewPicturesSection /></QueryClientProvider>);
}

test('CrewPicturesSection: classic placeholders say "Built-in placeholder", no Remove button', () => {
  const html = renderCrew({ manifest: CLASSIC_THEME, builtIn: true, images: {}, requested: null });
  for (const slot of ['orchestrator', 'planner', 'implementer', 'tester', 'reviewer']) {
    assert.match(html, new RegExp(`src="/themes/classic/${slot}\\.svg"`));
  }
  assert.match(html, /Built-in placeholder/);
  assert.doesNotMatch(html, />Remove<\/button>/);
});

test('CrewPicturesSection: an uploaded picture wins over the placeholder and can be removed', () => {
  const html = renderCrew({
    manifest: CLASSIC_THEME, builtIn: true, requested: null,
    images: { implementer: { url: '/api/themes/classic/images/implementer?v=1', version: '1' } },
  });
  assert.match(html, /src="\/api\/themes\/classic\/images\/implementer\?v=1"/);
  assert.match(html, />Remove<\/button>/);
  assert.doesNotMatch(html, /src="\/themes\/classic\/implementer\.svg"/);
});

test('CrewPicturesSection: the Hive has no placeholders, so an empty slot says "No picture"', () => {
  const html = renderCrew({ manifest: HIVE_THEME, builtIn: true, images: {}, requested: null });
  assert.doesNotMatch(html, /Built-in placeholder/);
  assert.match(html, /No picture/);
});
