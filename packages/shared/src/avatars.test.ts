import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseAvatarZip, sniffImageMime, avatarBodyLimitBytes } from './avatars.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const MAX = 1024 * 1024;

/** A minimal zip writer for the tests: one local header + central entry per file. Deflates when asked; can lie about the size. */
function zip(files: { name: string; data: Buffer; deflate?: boolean; claimedSize?: number }[]): Buffer {
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
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.claimedSize ?? f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
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

const parse = (files: Parameters<typeof zip>[0], maxBytes = MAX) => parseAvatarZip(zip(files), { maxBytes });

test('a valid zip yields one avatar per role, in role order, stored or deflated', () => {
  const r = parse([
    { name: 'reviewer.webp', data: WEBP },
    { name: 'planner.png', data: PNG, deflate: true },
    { name: 'implementer.jpg', data: JPG },
    { name: 'tester.gif', data: GIF, deflate: true },
  ]);
  assert.ok(r.ok);
  assert.deepEqual(r.avatars.map((a) => [a.role, a.mime]), [
    ['planner', 'image/png'], ['implementer', 'image/jpeg'], ['tester', 'image/gif'], ['reviewer', 'image/webp'],
  ]);
  assert.deepEqual(r.avatars[0].bytes, PNG);
  assert.deepEqual(r.avatars[2].bytes, GIF);
});

test('names match case-insensitively; .jpeg is JPEG', () => {
  const r = parse([{ name: 'Planner.PNG', data: PNG }, { name: 'TESTER.JPEG', data: JPG }]);
  assert.ok(r.ok);
  assert.deepEqual(r.avatars.map((a) => a.role), ['planner', 'tester']);
});

test('folders are ignored; __MACOSX, directory entries and other files are skipped', () => {
  const r = parse([
    { name: 'avatars/', data: Buffer.alloc(0) },
    { name: 'avatars/team/implementer.png', data: PNG },
    { name: '__MACOSX/avatars/team/._implementer.png', data: Buffer.from('junk') },
    { name: 'avatars/README.txt', data: Buffer.from('hi') },
    { name: 'avatars/designer.png', data: PNG },
  ]);
  assert.ok(r.ok);
  assert.deepEqual(r.avatars.map((a) => a.role), ['implementer']);
});

test('a role file with a disallowed extension is refused with a reason (no SVG)', () => {
  const r = parse([{ name: 'planner.png', data: PNG }, { name: 'tester.svg', data: Buffer.from('<svg/>') }]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /tester\.svg: only PNG, JPEG, GIF and WebP/);
});

test('bytes that do not match the extension are refused', () => {
  const r = parse([{ name: 'planner.png', data: JPG }]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /planner\.png is not really a PNG image \(it is image\/jpeg\)/);
  const html = parse([{ name: 'tester.gif', data: Buffer.from('<script>alert(1)</script>') }]);
  assert.equal(html.ok, false);
  assert.match(!html.ok ? html.reason : '', /not really a GIF/);
});

test('an image over the limit is refused, stored or deflated (a deflate bomb stops at the cap)', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2000)]);
  for (const deflate of [false, true]) {
    const r = parse([{ name: 'planner.png', data: big, deflate }], 1000);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /planner\.png is larger than/);
  }
  const bomb = parse([{ name: 'planner.png', data: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), deflate: true, claimedSize: 12 }], 1000);
  assert.equal(bomb.ok, false);
  assert.match(!bomb.ok ? bomb.reason : '', /planner\.png is larger than/);
});

test('a zip with no role images, the same role twice, and a non-zip are refused', () => {
  const none = parse([{ name: 'cat.png', data: PNG }, { name: 'notes.txt', data: Buffer.from('x') }]);
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : '', /No avatar images found.*planner, implementer, tester, reviewer/);

  const twice = parse([{ name: 'a/planner.png', data: PNG }, { name: 'b/Planner.gif', data: GIF }]);
  assert.equal(twice.ok, false);
  assert.match(!twice.ok ? twice.reason : '', /more than one planner/);

  const notZip = parseAvatarZip(PNG, { maxBytes: MAX });
  assert.deepEqual(notZip, { ok: false, reason: 'That file is not a zip archive.' });
});

test('sniffImageMime and the body limit', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(WEBP), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('<svg')), null);
  assert.equal(avatarBodyLimitBytes(3), Math.ceil(4 * 3 * 1024 * 1024 * 4 / 3) + 1024 * 1024);
});
