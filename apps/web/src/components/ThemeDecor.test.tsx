import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CLASSIC_THEME, HIVE_THEME, type ActiveThemeWire, type ThemeManifest } from '@asf/shared/ui';
import { ThemeDecor } from './ThemeDecor';

const render = (manifest: ThemeManifest) => {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], { manifest, builtIn: true, images: {}, requested: null } satisfies ActiveThemeWire);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><ThemeDecor /></QueryClientProvider>);
};

test('classic has no corner decor', () => {
  assert.equal(render(CLASSIC_THEME), '');
});

test('the Hive draws a honeycomb, hidden from screen readers', () => {
  const html = render(HIVE_THEME);
  assert.match(html, /^<svg[^>]*class="theme-decor"/);
  assert.match(html, /^<svg[^>]*aria-hidden="true"/);
  assert.ok((html.match(/<polygon/g) ?? []).length >= 6);
});

const renderWith = (manifest: ThemeManifest, decorUrl: string) => {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], {
    manifest, builtIn: true, images: {}, requested: null,
    decorImage: { url: decorUrl, version: '1' },
  } satisfies ActiveThemeWire);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><ThemeDecor /></QueryClientProvider>);
};

test('a decor picture replaces the Hive honeycomb', () => {
  const html = renderWith(HIVE_THEME, '/api/themes/hive/images/decor?v=1');
  assert.match(html, /^<img[^>]*class="theme-decor picture"/);
  assert.match(html, /src="\/api\/themes\/hive\/images\/decor\?v=1"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /<svg|<polygon/);
});

test('a decor picture shows even for a theme with no pattern', () => {
  const html = renderWith(CLASSIC_THEME, '/d.png');
  assert.match(html, /^<img[^>]*class="theme-decor picture"[^>]*src="\/d.png"/);
});
