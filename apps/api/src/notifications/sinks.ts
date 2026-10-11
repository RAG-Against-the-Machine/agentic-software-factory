import type { NotificationWire } from '@asf/shared';
import { resolve } from '@asf/shared';
import { registry } from '../registry/client.js';
import { cfg } from '../settings.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/**
 * External notification sinks (M6 WP6.3). The web inbox is the registry's
 * notification table read directly by the browser; it needs no delivery. This
 * module delivers the SAME rows to external sinks (Telegram first) exactly once,
 * driven by the row's delivered_at cursor so a restart never double-sends and a
 * sink that was off when a row was written picks it up when turned on.
 *
 * Runs in the api because only the api holds the sink credentials.
 */

export interface ExternalSink {
  readonly kind: string;
  send(n: NotificationWire): Promise<void>;
}

/** Turn a notification's relative deep link into an absolute URL when WEB_BASE_URL is set.
 * Tolerates the legacy '#/run/<id>' shape from rows written before the hash->path migration. */
function absolutize(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  const base = cfg('WEB_BASE_URL');
  if (!base) return url;
  const path = url.replace(/^#/, ''); // legacy '#/run/x' -> '/run/x'
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export class TelegramSink implements ExternalSink {
  readonly kind = 'telegram';
  constructor(private readonly token: string, private readonly chatId: string) {}

  async send(n: NotificationWire): Promise<void> {
    const lines = [`*${escapeMd(n.title)}*`, n.body ? escapeMd(n.body) : ''];
    const links = n.actions.map((a) => `[${escapeMd(a.label)}](${absolutize(a.url)})`).join(' · ');
    if (links) lines.push(links);
    const text = lines.filter(Boolean).join('\n');
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** MarkdownV2 requires these characters escaped. */
function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/** Build the enabled external sinks from settings. `web` is not here — it needs no delivery. */
export function loadExternalSinks(log: Log): ExternalSink[] {
  const names = String(cfg('NOTIFY_SINKS')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sinks: ExternalSink[] = [];
  if (names.includes('telegram')) {
    const token = cfg('TELEGRAM_BOT_TOKEN');
    const chatId = cfg('TELEGRAM_CHAT_ID');
    if (token && chatId) sinks.push(new TelegramSink(token, chatId));
    else log.warn({}, 'NOTIFY_SINKS includes telegram but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not both set; telegram sink disabled');
  }
  return sinks;
}

/**
 * One delivery pass: fetch undelivered rows, send each through every external
 * sink, and mark delivered. A row is marked delivered even if a sink throws (we
 * log and move on) so one broken sink cannot wedge the queue — the web inbox
 * still has the row regardless. With no external sinks, rows are marked
 * delivered immediately so the cursor does not grow unbounded.
 */
export async function deliverPass(sinks: ExternalSink[], log: Log): Promise<number> {
  const { notifications } = await registry.undeliveredNotifications();
  let sent = 0;
  for (const n of notifications) {
    for (const sink of sinks) {
      try { await sink.send(n); sent += 1; }
      catch (e) { log.error({ sink: sink.kind, id: n.id, err: (e as Error).message }, 'notification delivery failed'); }
    }
    await registry.markNotificationDelivered(n.id).catch((e) => log.error({ id: n.id, err: (e as Error).message }, 'mark delivered failed'));
  }
  return sent;
}

export function startNotifier(log: Log): () => void {
  const sinks = loadExternalSinks(log);
  if (sinks.length) log.info({ sinks: sinks.map((s) => s.kind) }, 'external notification sinks enabled');
  const period = resolve('NOTIFY_POLL_MS');
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await deliverPass(sinks, log); }
    catch (e) { log.error({ err: (e as Error).message }, 'notifier pass failed'); }
    finally { running = false; }
  }, period);
  timer.unref();
  return () => clearInterval(timer);
}
