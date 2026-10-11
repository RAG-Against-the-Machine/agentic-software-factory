import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  THEME_SLOTS, themeManifestSchema, themeImageInputSchema, contrastRatio, fillLine, pickLine, isThemeSlot, pickThemeImage, type ThemeManifest,
} from './theme.js';
import { BUILT_IN_THEMES, CLASSIC_THEME, HIVE_THEME, DEFAULT_THEME_ID, builtInTheme } from './themes/index.js';
import { parseThemePack } from './theme-pack.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const MAX = 1024 * 1024;

function zip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const custom = (over: Partial<ThemeManifest> = {}): ThemeManifest => ({ ...CLASSIC_THEME, id: 'robots', name: 'Robots', quips: undefined, moods: undefined, ...over });
const json = (v: unknown) => Buffer.from(JSON.stringify(v));

// --- manifest ---

test('both built-in themes validate, have distinct ids, and classic is the default', () => {
  for (const t of BUILT_IN_THEMES) assert.ok(themeManifestSchema.safeParse(t).success, t.id);
  assert.equal(new Set(BUILT_IN_THEMES.map((t) => t.id)).size, BUILT_IN_THEMES.length);
  assert.equal(DEFAULT_THEME_ID, 'classic');
  assert.equal(builtInTheme('hive'), HIVE_THEME);
  assert.equal(builtInTheme('nope'), undefined);
});

test('the hive theme names the crew and the Queen as agreed', () => {
  assert.equal(HIVE_THEME.crew.name, 'The Hive');
  assert.deepEqual(Object.fromEntries(THEME_SLOTS.map((s) => [s, HIVE_THEME.members[s].name])), {
    orchestrator: 'The Queen', planner: 'Scout', implementer: 'Builder', tester: 'Guard', reviewer: 'Inspector',
  });
});

test('classic keeps the run page wording it always had', () => {
  assert.equal(CLASSIC_THEME.crew.name, 'Team');
  // Plain descriptions of the work, no jokes.
  assert.equal(CLASSIC_THEME.quips?.planner?.[0], 'Reading the ticket');
  assert.equal(CLASSIC_THEME.quips?.reviewer?.at(-1), 'Deciding: approve or request changes');
  assert.deepEqual(CLASSIC_THEME.quips?.orchestrator, ['Starting the next step', 'Checking on the job', 'Recording progress']);
  assert.deepEqual(Object.keys(CLASSIC_THEME.quips ?? {}).sort(), [...THEME_SLOTS].sort());
});

test('classic parses and wears Dracula: dark background, light text, purple accent', () => {
  assert.ok(themeManifestSchema.safeParse(CLASSIC_THEME).success);
  assert.equal(CLASSIC_THEME.background, '#282a36');
  assert.equal(CLASSIC_THEME.text, '#f8f8f2');
  assert.equal(CLASSIC_THEME.accent, '#bd93f9');
});

test('the accent must be a plain hex colour (no CSS smuggling)', () => {
  for (const accent of ['red', '#e0a52', '#e0a526; background:url(x)', 'url(javascript:x)', '#e0a526ff']) {
    assert.equal(themeManifestSchema.safeParse(custom({ accent })).success, false, accent);
  }
  assert.ok(themeManifestSchema.safeParse(custom({ accent: '#E0A526' })).success);
});

test('appTitle is 1–40 characters of plain text', () => {
  assert.ok(themeManifestSchema.safeParse(custom({ appTitle: 'Robot Works' })).success);
  assert.ok(themeManifestSchema.safeParse(custom({ appTitle: 'x'.repeat(40) })).success);
  assert.equal(themeManifestSchema.safeParse(custom({ appTitle: 'x'.repeat(41) })).success, false);
  assert.equal(themeManifestSchema.safeParse(custom({ appTitle: '   ' })).success, false);
  assert.equal(CLASSIC_THEME.appTitle, 'Agentic Software Factory');
  assert.equal(HIVE_THEME.appTitle, 'The Hive Mind');
});

test('background and text must be plain hex colours (no CSS smuggling)', () => {
  for (const bad of ['black', '#fff', '#0f1115; color:red', 'url(x)', 'var(--bg)', '#0f1115ff']) {
    assert.equal(themeManifestSchema.safeParse(custom({ background: bad })).success, false, bad);
    assert.equal(themeManifestSchema.safeParse(custom({ text: bad })).success, false, bad);
  }
  assert.ok(themeManifestSchema.safeParse(custom({ background: '#FFFFFF', text: '#111111' })).success);
});

test('a theme whose text is hard to read on its background is refused with a reason', () => {
  const grey = themeManifestSchema.safeParse(custom({ background: '#777777', text: '#888888' }));
  assert.equal(grey.success, false);
  assert.match(grey.error!.issues[0].message, /contrast .*4\.5:1/);
  // A missing colour is the app's own: a dark background alone reads fine with the default light text…
  assert.ok(themeManifestSchema.safeParse(custom({ background: '#202020' })).success);
  // …but a light background alone leaves the default light text unreadable.
  assert.equal(themeManifestSchema.safeParse(custom({ background: '#f0f0f0' })).success, false);
  assert.equal(themeManifestSchema.safeParse(custom({ text: '#1a1a1a' })).success, false);
  assert.ok(contrastRatio(HIVE_THEME.background!, HIVE_THEME.text!) >= 4.5);
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(0), '21');
  assert.equal(contrastRatio('#123456', '#123456'), 1);
});

test('bad ids, over-long text, empty names, unknown keys and unknown slots are refused', () => {
  for (const id of ['A', 'x', '-lead', 'has space', 'a'.repeat(33), 'classic!']) {
    assert.equal(themeManifestSchema.safeParse(custom({ id })).success, false, id);
  }
  assert.equal(themeManifestSchema.safeParse(custom({ name: 'x'.repeat(41) })).success, false);
  assert.equal(themeManifestSchema.safeParse({ ...custom(), crew: { name: '  ' } }).success, false);
  assert.equal(themeManifestSchema.safeParse({ ...custom(), css: 'body{}' }).success, false);
  assert.equal(themeManifestSchema.safeParse({ ...custom(), quips: { designer: ['hi'] } }).success, false);
  assert.equal(themeManifestSchema.safeParse({ ...custom(), moods: { party: ['hi'] } }).success, false);
  assert.equal(themeManifestSchema.safeParse({ ...custom(), quips: { planner: ['x'.repeat(121)] } }).success, false);
  const fourMembers: Record<string, unknown> = { ...CLASSIC_THEME.members };
  delete fourMembers.reviewer;
  assert.equal(themeManifestSchema.safeParse({ ...custom(), members: fourMembers }).success, false);
});

test('fillLine fills only the known placeholders and leaves the rest as typed', () => {
  assert.equal(fillLine('{orchestrator} hands the work to {member}', { orchestrator: 'The Queen', member: 'Builder' }), 'The Queen hands the work to Builder');
  assert.equal(fillLine('{crew} on {ticket}', { crew: 'The Hive' }), 'The Hive on {ticket}');
  assert.equal(fillLine('{constructor} {__proto__} {toString}', { member: 'x' }), '{constructor} {__proto__} {toString}');
  assert.equal(fillLine('<b>{member}</b>', { member: '<script>' }), '<b><script></b>'); // plain text; React escapes it
});

test('pickLine is deterministic and wraps both ways; isThemeSlot', () => {
  const l = ['a', 'b', 'c'];
  assert.equal(pickLine(l, 0), 'a');
  assert.equal(pickLine(l, 4.9), 'b');
  assert.equal(pickLine(l, -1), 'c');
  assert.ok(isThemeSlot('orchestrator'));
  assert.equal(isThemeSlot('queen'), false);
});

// --- theme packs ---

test('a pack yields its manifest and pictures in slot order; queen.<ext> is the orchestrator', () => {
  const r = parseThemePack(zip([
    { name: 'robots/theme.json', data: json(custom()), deflate: true },
    { name: 'robots/reviewer.gif', data: GIF },
    { name: 'robots/Queen.PNG', data: PNG },
    { name: 'robots/planner.png', data: PNG, deflate: true },
    { name: '__MACOSX/robots/._theme.json', data: Buffer.from('junk') },
  ]), { maxBytes: MAX, requireManifest: true });
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.equal(r.manifest?.id, 'robots');
  assert.deepEqual(r.images.map((i) => [i.slot, i.mime]), [['orchestrator', 'image/png'], ['planner', 'image/png'], ['reviewer', 'image/gif']]);
});

test('pictures alone are fine unless a manifest is required; an empty pack is refused', () => {
  const pics = zip([{ name: 'orchestrator.gif', data: GIF }]);
  const r = parseThemePack(pics, { maxBytes: MAX });
  assert.ok(r.ok);
  assert.equal(r.manifest, null);
  assert.deepEqual(r.images.map((i) => i.slot), ['orchestrator']);

  const need = parseThemePack(pics, { maxBytes: MAX, requireManifest: true });
  assert.equal(need.ok, false);
  assert.match(!need.ok ? need.reason : '', /needs a theme\.json/);

  const empty = parseThemePack(zip([{ name: 'notes.txt', data: Buffer.from('x') }]), { maxBytes: MAX });
  assert.equal(empty.ok, false);
  assert.match(!empty.ok ? empty.reason : '', /No pictures found.*orchestrator, planner/);
});

test('a bad, invalid or built-in-named manifest is refused with a reason', () => {
  const bad = parseThemePack(zip([{ name: 'theme.json', data: Buffer.from('{nope') }]), { maxBytes: MAX });
  assert.match(!bad.ok ? bad.reason : '', /not valid JSON/);

  const invalid = parseThemePack(zip([{ name: 'theme.json', data: json(custom({ accent: 'red' })) }]), { maxBytes: MAX });
  assert.match(!invalid.ok ? invalid.reason : '', /theme\.json: accent: use a hex colour/);

  const clash = parseThemePack(zip([{ name: 'theme.json', data: json(custom({ id: 'hive' })) }]), { maxBytes: MAX });
  assert.match(!clash.ok ? clash.reason : '', /"hive" is a built-in theme/);
});

test('a huge manifest, two manifests, or queen + orchestrator together are refused', () => {
  const huge = parseThemePack(zip([{ name: 'theme.json', data: Buffer.alloc(40 * 1024, 0x20), deflate: true }]), { maxBytes: MAX });
  assert.match(!huge.ok ? huge.reason : '', /theme\.json is larger than 32 KB/);

  const two = parseThemePack(zip([{ name: 'a/theme.json', data: json(custom()) }, { name: 'b/THEME.json', data: json(custom()) }]), { maxBytes: MAX });
  assert.match(!two.ok ? two.reason : '', /more than one theme\.json/);

  const dup = parseThemePack(zip([{ name: 'queen.png', data: PNG }, { name: 'orchestrator.gif', data: GIF }]), { maxBytes: MAX });
  assert.match(!dup.ok ? dup.reason : '', /more than one orchestrator image/);
});

test('picture checks carry over from avatars: type, magic bytes, size', () => {
  const svg = parseThemePack(zip([{ name: 'queen.svg', data: Buffer.from('<svg/>') }]), { maxBytes: MAX });
  assert.match(!svg.ok ? svg.reason : '', /queen\.svg: only PNG, JPEG, GIF and WebP images can be pictures/);
  const lie = parseThemePack(zip([{ name: 'tester.png', data: GIF }]), { maxBytes: MAX });
  assert.match(!lie.ok ? lie.reason : '', /not really a PNG/);
  const big = parseThemePack(zip([{ name: 'tester.png', data: Buffer.concat([PNG, Buffer.alloc(2000)]), deflate: true }]), { maxBytes: 1000 });
  assert.match(!big.ok ? big.reason : '', /tester\.png is larger than/);
});

// --- M13: pictures per state ---

const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 \x00\x00', 'latin1');

test('M13: <member>-<state> names are state pictures beside the plain one; queen-<state> is the orchestrator', () => {
  const r = parseThemePack(zip([
    { name: 'bee3d-loops-webp/queen-idle.webp', data: WEBP },
    { name: 'bee3d-loops-webp/queen-working.webp', data: WEBP },
    { name: 'bee3d-loops-webp/Planner-Done.WEBP', data: WEBP, deflate: true },
    { name: 'bee3d-loops-webp/planner.png', data: PNG },
    { name: 'bee3d-loops-webp/.DS_Store', data: Buffer.from('junk') },
    { name: '__MACOSX/bee3d-loops-webp/._.DS_Store', data: Buffer.from('junk') },
  ]), { maxBytes: MAX });
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.deepEqual(r.images.map((i) => [i.slot, i.state, i.mime]), [
    ['orchestrator', 'idle', 'image/webp'], ['orchestrator', 'working', 'image/webp'],
    ['planner', 'any', 'image/png'], ['planner', 'done', 'image/webp'],
  ]);
});

test('M13: a name that is not a member and state is skipped; the same picture twice (queen-done + orchestrator-done) is refused', () => {
  const r = parseThemePack(zip([{ name: 'planner-sleeping.png', data: PNG }, { name: 'planner-idle.png', data: PNG }]), { maxBytes: MAX });
  assert.ok(r.ok);
  assert.deepEqual(r.images.map((i) => [i.slot, i.state]), [['planner', 'idle']]);
  const dup = parseThemePack(zip([{ name: 'queen-done.webp', data: WEBP }, { name: 'orchestrator-done.webp', data: WEBP }]), { maxBytes: MAX });
  assert.match(!dup.ok ? dup.reason : '', /more than one orchestrator-done image/);
  const none = parseThemePack(zip([{ name: 'bee-happy.webp', data: WEBP }]), { maxBytes: MAX });
  assert.match(!none.ok ? none.reason : '', /planner-idle\.webp, planner-working\.webp, planner-done\.webp/);
});

test('M13: a whole set of 15 fits when each is within the size; the pack as a whole is capped at five pictures worth', () => {
  const each = Buffer.concat([WEBP, Buffer.alloc(200)]);
  const set = ['queen', 'planner', 'implementer', 'tester', 'reviewer'].flatMap((m) => ['idle', 'working', 'done'].map((st) => ({ name: `${m}-${st}.webp`, data: each })));
  const ok = parseThemePack(zip(set), { maxBytes: 1000 });
  assert.ok(ok.ok, !ok.ok ? ok.reason : '');
  assert.equal(ok.images.length, 15);
  const tooMuch = parseThemePack(zip(set), { maxBytes: 300 }); // 15 x 214 bytes > 5 x 300
  assert.match(!tooMuch.ok ? tooMuch.reason : '', /add up to .* at most .* Upload them in two zips/);
});

test('M13: pickThemeImage takes the state picture, else the plain one; with no state, plain then idle, working, done', () => {
  assert.equal(pickThemeImage({ any: 'a', working: 'w' }, 'working'), 'w');
  assert.equal(pickThemeImage({ any: 'a', working: 'w' }, 'done'), 'a');
  assert.equal(pickThemeImage({ working: 'w' }, 'done'), null);
  assert.equal(pickThemeImage({ working: 'w', done: 'd' }), 'w');
  assert.equal(pickThemeImage({ idle: 'i', working: 'w' }), 'i');
  assert.equal(pickThemeImage({ any: 'a', idle: 'i' }), 'a');
  assert.equal(pickThemeImage(undefined, 'idle'), null);
});

test('decor is optional and only a known pattern is accepted', () => {
  assert.ok(themeManifestSchema.safeParse(custom({ decor: 'honeycomb' })).success);
  assert.ok(themeManifestSchema.safeParse(custom({})).success);
  for (const decor of ['stripes', '', 'url(x)']) {
    assert.equal(themeManifestSchema.safeParse(custom({ decor: decor as never })).success, false, decor);
  }
  assert.equal(HIVE_THEME.decor, 'honeycomb');
  assert.equal(CLASSIC_THEME.decor, undefined);
});

test('decor.png is the theme decor picture (state any); decor-<state> is not a picture', () => {
  const r = parseThemePack(zip([{ name: 'pack/decor.png', data: PNG }, { name: 'pack/planner.png', data: PNG }]), { maxBytes: MAX });
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.deepEqual(r.images.map((i) => [i.slot, i.state]), [['planner', 'any'], ['decor', 'any']]);
  const idle = parseThemePack(zip([{ name: 'decor-idle.png', data: PNG }, { name: 'tester.png', data: PNG }]), { maxBytes: MAX });
  assert.ok(idle.ok, !idle.ok ? idle.reason : '');
  assert.deepEqual(idle.images.map((i) => [i.slot, i.state]), [['tester', 'any']]);
});

test('the picture schema takes decor only without a state (or with any)', () => {
  const pic = { mime: 'image/png', contentBase64: 'eA==' };
  assert.ok(themeImageInputSchema.safeParse({ ...pic, slot: 'decor' }).success);
  assert.ok(themeImageInputSchema.safeParse({ ...pic, slot: 'decor', state: 'any' }).success);
  for (const state of ['idle', 'working', 'done']) {
    assert.equal(themeImageInputSchema.safeParse({ ...pic, slot: 'decor', state }).success, false, state);
  }
  assert.ok(themeImageInputSchema.safeParse({ ...pic, slot: 'planner', state: 'idle' }).success);
});
