import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramSink, deliverPass, type ExternalSink } from './sinks.js';
import type { NotificationWire } from '@asf/shared';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; for (const k of ['WEB_BASE_URL']) delete process.env[k]; });

const silent = { info: () => {}, error: () => {}, warn: () => {} };
function note(over: Partial<NotificationWire> = {}): NotificationWire {
  return { id: '1', runId: 'run_1', gateId: 'gate_1', kind: 'gate', title: 'N-1: approval needed at after plan',
    body: 'Run run_1 is waiting.', actions: [{ label: 'Review', url: '/run/run_1' }],
    createdAt: new Date().toISOString(), readAt: null, deliveredAt: null, ...over };
}

test('TelegramSink posts to the bot API with MarkdownV2 and escapes special chars', async () => {
  let sent: { url: string; body: Record<string, unknown> } | undefined;
  global.fetch = (async (url: string, init?: { body?: string }) => {
    sent = { url, body: JSON.parse((init?.body as string) ?? '{}') };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  process.env.WEB_BASE_URL = 'https://asf.example.com';
  await new TelegramSink('TOKEN', '12345').send(note());
  assert.ok(sent, 'fetch was called');
  assert.ok(String(sent.url).includes('/botTOKEN/sendMessage'), 'posts to the bot sendMessage endpoint');
  assert.equal(sent.body.chat_id, '12345');
  assert.equal(sent.body.parse_mode, 'MarkdownV2');
  const text = String(sent.body.text);
  // "." and "-" in the title must be escaped for MarkdownV2.
  assert.match(text, /N\\-1/);
  // The relative link is absolutized against WEB_BASE_URL.
  assert.match(text, /https:\/\/asf\.example\.com\/run\/run_1/);
});

test('absolutize tolerates a legacy #/run/<id> link (rows from before the hash->path migration)', async () => {
  let sent: { body: Record<string, unknown> } | undefined;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    sent = { body: JSON.parse((init?.body as string) ?? '{}') };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  process.env.WEB_BASE_URL = 'https://asf.example.com';
  await new TelegramSink('TOKEN', '12345').send(note({ actions: [{ label: 'Review', url: '#/run/run_1' }] }));
  assert.ok(sent, 'fetch was called');
  // The '#' is stripped so the absolute URL is the clean-path form, never '.../#/run/...'.
  assert.match(String(sent.body.text), /https:\/\/asf\.example\.com\/run\/run_1/);
});

test('TelegramSink throws on a non-2xx so deliverPass can log and continue', async () => {
  global.fetch = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(() => new TelegramSink('t', 'c').send(note()), /telegram sendMessage 400/);
});

test('deliverPass marks every row delivered even when a sink throws', async () => {
  const marked: string[] = [];
  let listed = false;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op?: string; id?: string };
    if (body.op === 'undeliveredNotifications') {
      if (listed) return json({ ok: true, result: { notifications: [] } });
      listed = true;
      return json({ ok: true, result: { notifications: [note({ id: 'a' }), note({ id: 'b' })] } });
    }
    if (body.op === 'markNotificationDelivered') { marked.push(body.id!); return json({ ok: true, result: { ok: true } }); }
    return json({ ok: true, result: {} });
  }) as unknown as typeof fetch;

  const boom: ExternalSink = { kind: 'boom', send: async () => { throw new Error('sink down'); } };
  const sent = await deliverPass([boom], silent);
  assert.equal(sent, 0, 'nothing delivered by the broken sink');
  assert.deepEqual(marked.sort(), ['a', 'b'], 'both rows still marked delivered so the queue never wedges');
});

test('deliverPass with no external sinks still drains the cursor', async () => {
  const marked: string[] = [];
  let listed = false;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op?: string; id?: string };
    if (body.op === 'undeliveredNotifications') { if (listed) return json({ ok: true, result: { notifications: [] } }); listed = true; return json({ ok: true, result: { notifications: [note({ id: 'x' })] } }); }
    if (body.op === 'markNotificationDelivered') { marked.push(body.id!); return json({ ok: true, result: { ok: true } }); }
    return json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
  await deliverPass([], silent);
  assert.deepEqual(marked, ['x']);
});

function json(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }); }
