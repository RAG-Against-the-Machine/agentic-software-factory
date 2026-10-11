import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HIVE_THEME, type ActiveThemeWire } from '@asf/shared/ui';
import { MemberAvatar } from './MemberAvatar';

const ref = (u: string) => ({ url: u, version: '1' });
function render(active: ActiveThemeWire, slot: string): string {
  const qc = new QueryClient();
  qc.setQueryData(['theme'], active);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><MemberAvatar slot={slot} state="done" /></QueryClientProvider>);
}

test('M13: a member with only state pictures shows its idle one, whole (not cropped to the circle)', () => {
  const active: ActiveThemeWire = {
    manifest: HIVE_THEME, builtIn: true, requested: null,
    images: { planner: ref('/api/themes/hive/images/planner/idle?v=1') },
    stateImages: { planner: { idle: ref('/api/themes/hive/images/planner/idle?v=1'), working: ref('/w'), done: ref('/d') } },
  };
  assert.match(render(active, 'planner'), /<img class="avatar sm whole done" src="\/api\/themes\/hive\/images\/planner\/idle\?v=1"/);
});

test('a member with only a plain picture is cropped to the circle as before', () => {
  const active: ActiveThemeWire = {
    manifest: HIVE_THEME, builtIn: true, requested: null,
    images: { planner: ref('/api/themes/hive/images/planner?v=1') },
    stateImages: { planner: { any: ref('/api/themes/hive/images/planner?v=1') } },
  };
  assert.match(render(active, 'planner'), /<img class="avatar sm done" src="\/api\/themes\/hive\/images\/planner\?v=1"/);
});
