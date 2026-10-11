import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAvatarRoutes } from './avatars.js';

// Avatars live in the registry, reached over HTTP via registry/client.ts, so
// global fetch is stubbed with a tiny in-memory registry.
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; delete process.env.AVATAR_MAX_MB; });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const META = { role: 'planner', mime: 'image/png', size: PNG.length, version: '1759300000000', updatedBy: null, updatedAt: '2025-10-01T06:26:40.000Z' };

function stubRegistry(calls: { op: string; [k: string]: unknown }[] = []) {
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string; [k: string]: unknown };
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (body.op) {
      case 'setAvatars': return ok({ avatars: [META] });
      case 'listAvatars': return ok({ avatars: [META] });
      case 'getAvatar': return ok({ avatar: body.role === 'planner' ? { ...META, contentBase64: PNG.toString('base64') } : null });
      case 'deleteAvatar': return ok({ deleted: body.role === 'planner' });
      default: return ok({});
    }
  }) as unknown as typeof fetch;
  return calls;
}

/** A stored-only zip: enough for the route; the parser itself is tested in @asf/shared. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, f.data);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function app() {
  const a = Fastify();
  registerAvatarRoutes(a);
  await a.ready();
  return a;
}

test('POST /api/avatars sends only the roles in the zip to the registry', async () => {
  const calls = stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/avatars', payload: { zipBase64: zip([{ name: 'team/Planner.png', data: PNG }, { name: 'readme.txt', data: Buffer.from('x') }]).toString('base64') } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().replaced, ['planner']);
  const sent = calls.find((c) => c.op === 'setAvatars')!.avatars as { role: string; mime: string; contentBase64: string }[];
  assert.deepEqual(sent.map((x) => [x.role, x.mime]), [['planner', 'image/png']]);
  assert.deepEqual(Buffer.from(sent[0].contentBase64, 'base64'), PNG);
  await a.close();
});

test('POST /api/avatars refuses a missing zip, a renamed file, an oversized image and no role files', async () => {
  process.env.AVATAR_MAX_MB = '1';
  const calls = stubRegistry();
  const a = await app();
  const post = (files: { name: string; data: Buffer }[] | null) =>
    a.inject({ method: 'POST', url: '/api/avatars', payload: files ? { zipBase64: zip(files).toString('base64') } : {} });

  assert.equal((await post(null)).statusCode, 400);

  const renamed = await post([{ name: 'tester.png', data: JPG }]);
  assert.equal(renamed.statusCode, 400);
  assert.equal(renamed.json().error, 'bad_avatar');
  assert.match(renamed.json().reason, /not really a PNG/);

  const big = await post([{ name: 'tester.png', data: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) }]);
  assert.equal(big.statusCode, 400);
  assert.match(big.json().reason, /larger than 1 MB/);

  const none = await post([{ name: 'cat.png', data: PNG }]);
  assert.equal(none.statusCode, 400);
  assert.match(none.json().reason, /No avatar images found/);

  assert.equal(calls.filter((c) => c.op === 'setAvatars').length, 0, 'nothing refused reaches the registry');
  await a.close();
});

test('GET /api/avatars/:role sends the real type, nosniff, and caches only the current version', async () => {
  stubRegistry();
  const a = await app();
  const res = await a.inject({ method: 'GET', url: `/api/avatars/planner?v=${META.version}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(res.headers.etag, `"${META.version}"`);
  assert.deepEqual(res.rawPayload, PNG);

  const stale = await a.inject({ method: 'GET', url: '/api/avatars/planner?v=old' });
  assert.equal(stale.headers['cache-control'], 'no-cache');
  assert.equal((await a.inject({ method: 'GET', url: '/api/avatars/planner', headers: { 'if-none-match': `"${META.version}"` } })).statusCode, 304);

  assert.equal((await a.inject({ method: 'GET', url: '/api/avatars/reviewer' })).statusCode, 404);
  assert.equal((await a.inject({ method: 'GET', url: '/api/avatars/designer' })).statusCode, 400);
  await a.close();
});

test('GET /api/avatars lists them; DELETE /api/avatars/:role removes one', async () => {
  const calls = stubRegistry();
  const a = await app();
  const list = (await a.inject({ method: 'GET', url: '/api/avatars' })).json();
  assert.deepEqual(list.roles, ['planner', 'implementer', 'tester', 'reviewer']);
  assert.deepEqual(list.avatars, [META]);

  assert.equal((await a.inject({ method: 'DELETE', url: '/api/avatars/planner' })).statusCode, 200);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/avatars/tester' })).statusCode, 404);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/avatars/designer' })).statusCode, 400);
  assert.deepEqual(calls.filter((c) => c.op === 'deleteAvatar').map((c) => c.role), ['planner', 'tester']);
  await a.close();
});
