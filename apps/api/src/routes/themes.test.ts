import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { CLASSIC_THEME } from '@asf/shared';
import { registerThemeRoutes, storedZip } from './themes.js';

// Themes live in the registry (over HTTP via registry/client.ts), so global
// fetch is stubbed with a tiny in-memory registry that also holds org settings.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.AVATAR_MAX_MB; delete process.env.THEME; });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const robots = { ...CLASSIC_THEME, id: 'robots', name: 'Robots', crew: { name: 'The Fleet' }, quips: undefined, moods: undefined };

type Call = { op: string; [k: string]: unknown };
function stubRegistry(state: { custom?: Record<string, unknown>; org?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const custom: Record<string, unknown> = { ...(state.custom ?? {}) };
  const org: Record<string, unknown> = { ...(state.org ?? {}) };
  const img = (themeId: string, slot: string) => ({ themeId, slot, mime: 'image/png', size: PNG.length, version: '1759300000000', updatedBy: null, updatedAt: '2025-10-01T06:26:40.000Z' });
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as Call;
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'getOrgSettings': return ok({ settings: { ...org } });
      case 'putOrgSetting': org[body.key as string] = body.value; return ok({});
      case 'listThemes': return ok({ themes: Object.values(custom).map((manifest) => ({ manifest, updatedBy: null, updatedAt: '' })) });
      case 'getTheme': return ok({ theme: custom[body.id as string] ? { manifest: custom[body.id as string], updatedBy: null, updatedAt: '' } : null });
      case 'putTheme': { const m = body.manifest as { id: string }; custom[m.id] = m; return ok({ theme: { manifest: m, updatedBy: body.by, updatedAt: '' } }); }
      case 'deleteTheme': { const had = body.id as string in custom; delete custom[body.id as string]; return ok({ deleted: had }); }
      case 'listThemeImages': return ok({ images: body.themeId === null ? [img('hive', 'orchestrator')] : body.themeId === 'hive' ? [img('hive', 'orchestrator')] : [] });
      case 'setThemeImages': return ok({ images: (body.images as { slot: string }[]).map((i) => img(body.themeId as string, i.slot)) });
      case 'getThemeImage': return ok({ image: body.themeId === 'hive' && body.slot === 'orchestrator' ? { ...img('hive', 'orchestrator'), contentBase64: PNG.toString('base64') } : null });
      case 'deleteThemeImage': return ok({ deleted: body.themeId === 'hive' && body.slot === 'orchestrator' ? 1 : 0 });
      default: return ok({});
    }
  }) as unknown as typeof fetch;
  return { calls, org, custom };
}

function zip(files: { name: string; data: Buffer }[]): string {
  return storedZip(files).toString('base64');
}

async function app() {
  const a = Fastify();
  registerThemeRoutes(a);
  await a.ready();
  return a;
}

test('GET /api/theme serves classic by default with no pictures', async () => {
  stubRegistry();
  const a = await app();
  const res = (await a.inject({ url: '/api/theme' })).json();
  assert.equal(res.manifest.id, 'classic');
  assert.equal(res.builtIn, true);
  assert.deepEqual(res.images, {});
  assert.equal(res.requested, null);
  await a.close();
});

test('THEME=hive serves the Hive with versioned picture URLs; a missing theme falls back to classic and says which', async () => {
  stubRegistry();
  process.env.THEME = 'hive';
  const a = await app();
  const hive = (await a.inject({ url: '/api/theme' })).json();
  assert.equal(hive.manifest.members.orchestrator.name, 'The Queen');
  assert.deepEqual(hive.images.orchestrator, { url: '/api/themes/hive/images/orchestrator?v=1759300000000', version: '1759300000000' });

  process.env.THEME = 'vanished';
  const fell = (await a.inject({ url: '/api/theme' })).json();
  assert.equal(fell.manifest.id, 'classic');
  assert.equal(fell.requested, 'vanished');
  await a.close();
});

test('PUT /api/theme saves THEME as an org setting, refuses an unknown theme, and refuses when the env pins it', async () => {
  const { org } = stubRegistry();
  const a = await app();
  const set = await a.inject({ method: 'PUT', url: '/api/theme', payload: { id: 'Hive' } });
  assert.equal(set.statusCode, 200);
  assert.equal(org.THEME, 'hive');
  assert.equal(set.json().manifest.id, 'hive');

  const unknown = await a.inject({ method: 'PUT', url: '/api/theme', payload: { id: 'nope' } });
  assert.equal(unknown.statusCode, 404);
  assert.match(unknown.json().reason, /no theme called "nope"/);

  process.env.THEME = 'classic';
  const pinned = await a.inject({ method: 'PUT', url: '/api/theme', payload: { id: 'hive' } });
  assert.equal(pinned.statusCode, 409);
  await a.close();
});

test('GET /api/themes lists built-ins then uploads, marks the active one, and carries picture URLs', async () => {
  stubRegistry({ custom: { robots } });
  process.env.THEME = 'robots';
  const a = await app();
  const res = (await a.inject({ url: '/api/themes' })).json();
  assert.deepEqual(res.themes.map((t: { id: string; builtIn: boolean; active: boolean }) => [t.id, t.builtIn, t.active]), [['classic', true, false], ['hive', true, false], ['robots', false, true]]);
  assert.equal(res.themes[1].images.orchestrator.url, '/api/themes/hive/images/orchestrator?v=1759300000000');
  assert.equal(res.themes[2].crewName, 'The Fleet');
  assert.equal(res.envPinned, true);
  await a.close();
});

test('POST /api/themes stores a pack; it needs a theme.json and refuses bad packs with a reason', async () => {
  const { calls } = stubRegistry();
  const a = await app();
  const post = (zipBase64?: string) => a.inject({ method: 'POST', url: '/api/themes', payload: zipBase64 ? { zipBase64 } : {} });

  const ok = await post(zip([{ name: 'robots/theme.json', data: Buffer.from(JSON.stringify(robots)) }, { name: 'robots/queen.gif', data: GIF }]));
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json().pictures, ['orchestrator']);
  const sent = calls.find((c) => c.op === 'putTheme')!;
  assert.equal((sent.manifest as { id: string }).id, 'robots');
  assert.deepEqual((sent.images as { slot: string; mime: string }[]).map((i) => [i.slot, i.mime]), [['orchestrator', 'image/gif']]);

  assert.equal((await post()).statusCode, 400);
  const pics = await post(zip([{ name: 'planner.png', data: PNG }]));
  assert.equal(pics.statusCode, 400);
  assert.match(pics.json().reason, /needs a theme\.json/);
  const builtin = await post(zip([{ name: 'theme.json', data: Buffer.from(JSON.stringify({ ...robots, id: 'hive' })) }]));
  assert.match(builtin.json().reason, /"hive" is a built-in theme/);
  await a.close();
});

test('POST /api/themes/:id/images replaces pictures on any existing theme and refuses a manifest there', async () => {
  const { calls } = stubRegistry();
  const a = await app();
  const post = (id: string, files: { name: string; data: Buffer }[]) => a.inject({ method: 'POST', url: `/api/themes/${id}/images`, payload: { zipBase64: zip(files) } });

  const ok = await post('hive', [{ name: 'bees/Queen.GIF', data: GIF }, { name: 'bees/tester.png', data: PNG }]);
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json().replaced, ['orchestrator', 'tester']);
  assert.equal(calls.find((c) => c.op === 'setThemeImages')!.themeId, 'hive');

  assert.equal((await post('ghost', [{ name: 'planner.png', data: PNG }])).statusCode, 404);
  const withManifest = await post('hive', [{ name: 'theme.json', data: Buffer.from(JSON.stringify(robots)) }]);
  assert.equal(withManifest.statusCode, 400);
  assert.match(withManifest.json().reason, /upload pictures only/);
  await a.close();
});

test('a picture is served with its type, nosniff and an immutable cache only at its current version', async () => {
  stubRegistry();
  const a = await app();
  const cur = await a.inject({ url: '/api/themes/hive/images/orchestrator?v=1759300000000' });
  assert.equal(cur.statusCode, 200);
  assert.equal(cur.headers['content-type'], 'image/png');
  assert.equal(cur.headers['x-content-type-options'], 'nosniff');
  assert.match(String(cur.headers['cache-control']), /immutable/);
  assert.deepEqual(cur.rawPayload, PNG);
  assert.equal((await a.inject({ url: '/api/themes/hive/images/orchestrator?v=old' })).headers['cache-control'], 'no-cache');
  assert.equal((await a.inject({ url: '/api/themes/hive/images/orchestrator', headers: { 'if-none-match': '"1759300000000"' } })).statusCode, 304);
  assert.equal((await a.inject({ url: '/api/themes/hive/images/queen' })).statusCode, 400);
  assert.equal((await a.inject({ url: '/api/themes/..%2Fetc/images/planner' })).statusCode, 400);
  assert.equal((await a.inject({ url: '/api/themes/hive/images/planner' })).statusCode, 404);
  await a.close();
});

test('deleting: built-ins and the active theme are refused; pictures delete per slot', async () => {
  stubRegistry({ custom: { robots } });
  process.env.THEME = 'robots';
  const a = await app();
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/hive' })).statusCode, 400);
  const active = await a.inject({ method: 'DELETE', url: '/api/themes/robots' });
  assert.equal(active.statusCode, 409);
  assert.match(active.json().reason, /in use/);
  process.env.THEME = 'classic';
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/robots' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/robots' })).statusCode, 404);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/orchestrator' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/planner' })).statusCode, 404);
  await a.close();
});

test('the template zip unzips to an editable classic manifest that our own parser accepts once renamed', async () => {
  stubRegistry();
  const a = await app();
  const res = await a.inject({ url: '/api/themes/template.zip' });
  assert.equal(res.headers['content-type'], 'application/zip');
  const { parseThemePack } = await import('@asf/shared');
  const pack = parseThemePack(res.rawPayload, { maxBytes: 1024 * 1024, requireManifest: true });
  assert.ok(pack.ok, !pack.ok ? pack.reason : '');
  assert.equal(pack.manifest?.id, 'my-theme');
  assert.deepEqual(pack.manifest?.members, CLASSIC_THEME.members);
  await a.close();
});

// --- M13: pictures per state ---

const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 \x00\x00', 'latin1');

/** A registry holding real per-state pictures for hive, so the api's URL and fallback logic is what is tested. */
function stateRegistry() {
  const pics = new Map<string, { mime: string; bytes: Buffer; version: string }>();
  let clock = 1759300000000;
  const key = (t: string, s: string, st: string) => `${t}/${s}/${st}`;
  const meta = (k: string) => { const [themeId, slot, state] = k.split('/'); const p = pics.get(k)!; return { themeId, slot, state, mime: p.mime, size: p.bytes.length, version: p.version, updatedBy: null, updatedAt: '' }; };
  const calls: Call[] = [];
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as Call;
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    const list = (t: string | null) => [...pics.keys()].filter((k) => t === null || k.startsWith(`${t}/`)).map(meta);
    switch (body.op) {
      case 'getOrgSettings': return ok({ settings: { THEME: 'hive' } });
      case 'listThemes': return ok({ themes: [] });
      case 'getTheme': return ok({ theme: null });
      case 'listThemeImages': return ok({ images: list(body.themeId as string | null) });
      case 'setThemeImages': for (const i of body.images as { slot: string; state?: string; mime: string; contentBase64: string }[]) pics.set(key(body.themeId as string, i.slot, i.state ?? 'any'), { mime: i.mime, bytes: Buffer.from(i.contentBase64, 'base64'), version: String(++clock) }); return ok({ images: list(body.themeId as string) });
      case 'getThemeImage': { const k = key(body.themeId as string, body.slot as string, (body.state as string) ?? 'any'); const p = pics.get(k); return ok({ image: p ? { ...meta(k), contentBase64: p.bytes.toString('base64') } : null }); }
      case 'deleteThemeImage': { let n = 0; for (const k of [...pics.keys()]) if (k.startsWith(`${body.themeId}/${body.slot}/`) && (!body.state || k.endsWith(`/${body.state}`))) { pics.delete(k); n++; } return ok({ deleted: n }); }
      default: return ok({});
    }
  }) as unknown as typeof fetch;
  return { calls, pics };
}

test('M13: a state pack uploads every picture with its state; /api/theme gives stateImages and a default per member', async () => {
  const { calls } = stateRegistry();
  const a = await app();
  const up = await a.inject({ method: 'POST', url: '/api/themes/hive/images', payload: { zipBase64: zip([
    { name: 'bee3d/queen-idle.webp', data: WEBP }, { name: 'bee3d/queen-working.webp', data: WEBP }, { name: 'bee3d/queen-done.webp', data: WEBP },
    { name: 'bee3d/planner-working.webp', data: WEBP }, { name: 'bee3d/tester.png', data: PNG },
  ]) } });
  assert.equal(up.statusCode, 201, up.body);
  assert.deepEqual(up.json().replaced, ['orchestrator-idle', 'orchestrator-working', 'orchestrator-done', 'planner-working', 'tester']);
  const sent = calls.find((c) => c.op === 'setThemeImages')!.images as { slot: string; state: string }[];
  assert.deepEqual(sent.map((i) => `${i.slot}:${i.state}`), ['orchestrator:idle', 'orchestrator:working', 'orchestrator:done', 'planner:working', 'tester:any']);

  const t = (await a.inject({ url: '/api/theme' })).json();
  assert.match(t.stateImages.orchestrator.working.url, /^\/api\/themes\/hive\/images\/orchestrator\/working\?v=\d+$/);
  assert.match(t.stateImages.tester.any.url, /^\/api\/themes\/hive\/images\/tester\?v=\d+$/, 'a plain picture keeps its M12 URL');
  assert.deepEqual(Object.keys(t.stateImages.orchestrator), ['idle', 'working', 'done']);
  // images: one per member for thumbnails: plain, else idle, working, done.
  assert.equal(t.images.orchestrator.url, t.stateImages.orchestrator.idle.url);
  assert.equal(t.images.planner.url, t.stateImages.planner.working.url);
  assert.equal(t.images.tester.url, t.stateImages.tester.any.url);
  assert.equal(t.images.reviewer, undefined);
});

test('M13: a state picture is served at /:slot/:state; an unknown state is a 400; a missing one a 404', async () => {
  stateRegistry();
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/themes/hive/images', payload: { zipBase64: zip([{ name: 'queen-working.webp', data: WEBP }, { name: 'queen.png', data: PNG }]) } });
  const t = (await a.inject({ url: '/api/theme' })).json();
  const w = await a.inject({ url: t.stateImages.orchestrator.working.url });
  assert.equal(w.statusCode, 200);
  assert.equal(w.headers['content-type'], 'image/webp');
  assert.match(String(w.headers['cache-control']), /immutable/);
  assert.deepEqual(w.rawPayload, WEBP);
  const plain = await a.inject({ url: '/api/themes/hive/images/orchestrator' });
  assert.equal(plain.headers['content-type'], 'image/png');
  assert.equal((await a.inject({ url: '/api/themes/hive/images/orchestrator/any' })).headers['content-type'], 'image/png');
  assert.equal((await a.inject({ url: '/api/themes/hive/images/orchestrator/sleeping' })).statusCode, 400);
  assert.equal((await a.inject({ url: '/api/themes/hive/images/planner/done' })).statusCode, 404);
});

test('M13: delete one state, or every picture a member has', async () => {
  const { pics } = stateRegistry();
  const a = await app();
  await a.inject({ method: 'POST', url: '/api/themes/hive/images', payload: { zipBase64: zip([
    { name: 'planner-idle.webp', data: WEBP }, { name: 'planner-working.webp', data: WEBP }, { name: 'planner.png', data: PNG },
  ]) } });
  const one = await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/planner/idle' });
  assert.deepEqual(one.json(), { ok: true, deleted: 1 });
  assert.deepEqual([...pics.keys()].sort(), ['hive/planner/any', 'hive/planner/working']);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/planner/idle' })).statusCode, 404);
  const all = await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/planner' });
  assert.deepEqual(all.json(), { ok: true, deleted: 2 });
  assert.equal(pics.size, 0);
});

test('decor.png uploads as the decor picture: /api/theme has decorImage, crew images do not; it serves and deletes', async () => {
  const { calls, pics } = stateRegistry();
  const a = await app();
  const up = await a.inject({ method: 'POST', url: '/api/themes/hive/images', payload: { zipBase64: zip([{ name: 'decor.png', data: PNG }, { name: 'queen.webp', data: WEBP }]) } });
  assert.equal(up.statusCode, 201, up.body);
  assert.deepEqual(up.json().replaced, ['orchestrator', 'decor']);
  assert.match(up.json().decorImage.url, /^\/api\/themes\/hive\/images\/decor\?v=\d+$/);
  assert.equal('decor' in up.json().images, false);
  const sent = calls.find((c) => c.op === 'setThemeImages')!.images as { slot: string; state: string }[];
  assert.deepEqual(sent.map((i) => `${i.slot}:${i.state}`), ['orchestrator:any', 'decor:any']);

  const t = (await a.inject({ url: '/api/theme' })).json();
  assert.match(t.decorImage.url, /^\/api\/themes\/hive\/images\/decor\?v=\d+$/);
  assert.equal('decor' in t.images, false);
  assert.equal('decor' in t.stateImages, false);
  assert.deepEqual(Object.keys(t.images), ['orchestrator']);

  const got = await a.inject({ url: t.decorImage.url });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.deepEqual(got.rawPayload, PNG);
  assert.equal((await a.inject({ url: '/api/themes/hive/images/decor/idle' })).statusCode, 400);
  assert.equal((await a.inject({ url: '/api/themes/hive/images/decor/any' })).statusCode, 400);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/decor/idle' })).statusCode, 400);

  assert.deepEqual((await a.inject({ method: 'DELETE', url: '/api/themes/hive/images/decor' })).json(), { ok: true, deleted: 1 });
  assert.deepEqual([...pics.keys()], ['hive/orchestrator/any']);
  assert.equal((await a.inject({ url: '/api/theme' })).json().decorImage, null);
});
