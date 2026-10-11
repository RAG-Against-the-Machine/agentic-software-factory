import type {
  Preflight, Ticket, TicketBucket, TicketComment, TicketLink, TicketListQuery,
  TicketProvider, TicketProviderCapabilities, TicketTransition,
} from '@asf/shared';
import { preflightFailure } from '../../rejected.js';

/**
 * Trello as a TicketProvider. Trello is deliberately UNLIKE Jira/GitHub — it has
 * no issues, sprints or status field: a board holds lists, a list holds cards,
 * and a card's "status" IS the list it sits in. This provider proves the
 * white-label seam against a genuinely different tracker.
 *
 * Auth is a key+token pair passed as query params (?key=&token=), not a header.
 * The api is the only process that holds them; agents never see them.
 *
 * Identity mapping:
 *   id  = card.id (opaque 24-hex)
 *   key = "#<idShort>"      (the card's board-local short number, e.g. "#42")
 *   url = card.shortUrl     (copied, never constructed)
 *   status = the card's list name
 * Bucket:  TRELLO_LIST_BUCKET_MAP (listName=bucket) first, else a position
 *          heuristic — first list on the board → backlog, last → done, else inflight.
 * Priority: Trello has none → always null.
 * There are no native subtasks (checklists ≈ subtasks, out of scope) → createSubtask throws.
 */

export interface TrelloTicketConfig {
  key: string;
  token: string;
  boards: string[];          // board ids
  listBucketMap: Array<{ list: string; bucket: TicketBucket }>;
  apiUrl?: string;           // default https://api.trello.com/1
}

interface TrelloMember { id: string; username: string; fullName?: string }
interface TrelloLabel { id: string; name: string; color?: string | null }
interface TrelloAttachment { id: string; name: string; url: string }
interface TrelloList { id: string; name: string; pos: number }
interface TrelloCard {
  id: string; idShort: number; name: string; desc: string; shortUrl: string;
  idList: string; idMembers: string[]; idBoard: string;
  labels: TrelloLabel[]; dateLastActivity: string;
  attachments?: TrelloAttachment[];
}
interface TrelloAction { id: string; type: string; date: string; memberCreator?: TrelloMember; data?: { text?: string } }

const VALID_BUCKETS: TicketBucket[] = ['backlog', 'ready', 'inflight', 'review', 'blocked', 'done'];

/**
 * The id of the synthetic "mark complete" transition (sets the card's
 * `dueComplete` flag). A literal, not a Trello list id — Trello list ids are
 * 24-hex, so this never collides with a real list.
 */
const DUE_COMPLETE_ID = 'dueComplete';

/** Parse "List Name=bucket, Other=done" rules (listName matched case-insensitively). */
export function parseListBucketMap(raw: string): TrelloTicketConfig['listBucketMap'] {
  const out: TrelloTicketConfig['listBucketMap'] = [];
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.lastIndexOf('=');
    if (eq < 0) continue;
    const list = pair.slice(0, eq).trim();
    const bucket = pair.slice(eq + 1).trim() as TicketBucket;
    if (list && VALID_BUCKETS.includes(bucket)) out.push({ list, bucket });
  }
  return out;
}

/**
 * Bucket for a card: an explicit list-name rule wins; otherwise a position
 * heuristic over the board's ordered lists — the first list is where new work
 * lands (backlog), the last is where finished work goes (done), everything
 * between is inflight. `orderedLists` must be sorted by pos ascending.
 */
export function bucketOf(listId: string, orderedLists: TrelloList[], map: TrelloTicketConfig['listBucketMap']): TicketBucket {
  const list = orderedLists.find((l) => l.id === listId);
  if (list) {
    for (const rule of map) if (rule.list.toLowerCase() === list.name.toLowerCase()) return rule.bucket;
  }
  if (orderedLists.length === 0 || !list) return 'backlog';
  if (list.id === orderedLists[0].id) return 'backlog';
  if (list.id === orderedLists[orderedLists.length - 1].id) return 'done';
  return 'inflight';
}

export class TrelloTicketProvider implements TicketProvider {
  readonly kind = 'trello' as const;
  private readonly cfg: TrelloTicketConfig;
  private readonly base: string;

  constructor(cfg: TrelloTicketConfig) {
    this.cfg = cfg;
    this.base = (cfg.apiUrl ?? 'https://api.trello.com/1').replace(/\/+$/, '');
  }

  private async trello<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const qs = new URLSearchParams({ key: this.cfg.key, token: this.cfg.token, ...query });
    const res = await fetch(`${this.base}${path}?${qs.toString()}`, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Trello ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  /** GET the ordered lists on a board (pos ascending) — needed for the bucket heuristic + transitions. */
  private async boardLists(boardId: string): Promise<TrelloList[]> {
    const lists = await this.trello<TrelloList[]>('GET', `/boards/${boardId}/lists`, { fields: 'id,name,pos', filter: 'open' });
    return lists.slice().sort((a, b) => a.pos - b.pos);
  }

  private toTicket(card: TrelloCard, lists: TrelloList[]): Ticket {
    const list = lists.find((l) => l.id === card.idList);
    const links: TicketLink[] = (card.attachments ?? [])
      .filter((a) => /^https?:\/\//.test(a.url))
      .map((a) => ({ title: a.name || a.url, url: a.url, kind: 'other' as const }));
    return {
      id: card.id,
      key: `#${card.idShort}`,
      url: card.shortUrl,
      title: card.name,
      body: card.desc ?? '',            // Trello desc is Markdown-ish; pass through
      status: list?.name ?? '',
      bucket: bucketOf(card.idList, lists, this.cfg.listBucketMap),
      priority: null,                   // Trello has no priority
      assignee: card.idMembers[0] ?? null,
      labels: card.labels.map((l) => l.name).filter(Boolean),
      links,
      parentId: null,
      children: [],
      updatedAt: card.dateLastActivity,
    };
  }

  async preflight(): Promise<Preflight> {
    if (!this.cfg.key || !this.cfg.token) return { ok: false, reason: 'TRELLO_KEY and TRELLO_TOKEN must both be set' };
    if (this.cfg.boards.length === 0) return { ok: false, reason: 'TRELLO_BOARDS is empty (no board id to read)' };
    try {
      // /members/me, not a search — a dead token still 200s on some search endpoints (mirrors the Jira /myself lesson).
      const me = await this.trello<TrelloMember>('GET', '/members/me', { fields: 'id,username,fullName' });
      for (const b of this.cfg.boards) await this.trello('GET', `/boards/${b}`, { fields: 'id' });
      return { ok: true, identity: me.username };
    } catch (e) {
      return preflightFailure('Trello', e);
    }
  }

  capabilities(): TicketProviderCapabilities {
    // Trello has boards (and no sprints), but the backlog-scoping board mapping is
    // deferred (see docs/BACKLOG_SCOPING.md "Other trackers"): flags stay false
    // and the discovery methods throw until that mapping lands.
    return { subtasks: false, priority: false, links: true, transitions: true, assignable: true, boards: false, sprints: false, statuses: false };
  }

  async listScopes(): Promise<never> { throw new Error('trello: board discovery not supported yet'); }
  async listSprints(): Promise<never> { throw new Error('trello: sprints not supported'); }
  async listStatuses(): Promise<never> { throw new Error('trello: status discovery not supported yet'); }

  async list(q: TicketListQuery): Promise<{ tickets: Ticket[]; next?: string }> {
    const scope = q.scope.length ? q.scope : this.cfg.boards;
    const all: Ticket[] = [];
    for (const boardId of scope) {
      const lists = await this.boardLists(boardId);
      const cards = await this.trello<TrelloCard[]>('GET', `/boards/${boardId}/cards`, {
        fields: 'id,idShort,name,desc,shortUrl,idList,idMembers,idBoard,labels,dateLastActivity',
        attachments: 'true', attachment_fields: 'name,url',
      });
      for (const card of cards) all.push(this.toTicket(card, lists));
    }
    let out = all;
    if (q.bucket?.length) out = out.filter((t) => q.bucket!.includes(t.bucket));
    if (q.search) out = out.filter((t) => t.title.toLowerCase().includes(q.search!.toLowerCase()));
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // Cursor-page in memory (Trello has no stable list cursor across boards).
    const start = q.cursor ? Number(q.cursor) || 0 : 0;
    const page = out.slice(start, start + q.limit);
    const next = start + q.limit < out.length ? String(start + q.limit) : undefined;
    return { tickets: page, next };
  }

  /** A card carries its board id; fetch it + that board's lists to resolve status/bucket. */
  private async fetchCard(id: string): Promise<{ card: TrelloCard; lists: TrelloList[] }> {
    const card = await this.trello<TrelloCard>('GET', `/cards/${id}`, {
      fields: 'id,idShort,name,desc,shortUrl,idList,idMembers,idBoard,labels,dateLastActivity',
      attachments: 'true', attachment_fields: 'name,url',
    });
    const lists = await this.boardLists(card.idBoard);
    return { card, lists };
  }

  async get(id: string): Promise<Ticket> {
    const { card, lists } = await this.fetchCard(id);
    return this.toTicket(card, lists);
  }

  async update(id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>): Promise<Ticket> {
    const query: Record<string, string> = {};
    if (patch.title !== undefined) query.name = patch.title;
    if (patch.body !== undefined) query.desc = patch.body;
    // priority: Trello has none → silently ignored. labels: resolve names to board label ids.
    if (patch.labels !== undefined) {
      const current = await this.trello<TrelloCard>('GET', `/cards/${id}`, { fields: 'idBoard' });
      const boardLabels = await this.trello<TrelloLabel[]>('GET', `/boards/${current.idBoard}/labels`, { fields: 'id,name' });
      const ids = patch.labels
        .map((name) => boardLabels.find((bl) => bl.name.toLowerCase() === name.toLowerCase())?.id)
        .filter((x): x is string => Boolean(x));
      query.idLabels = ids.join(',');
    }
    await this.trello('PUT', `/cards/${id}`, query);
    return this.get(id);
  }

  async createSubtask(): Promise<Ticket> {
    // Capability=false; callers guard on capabilities().subtasks before calling.
    throw new Error('trello: subtasks not supported');
  }

  async addLink(id: string, link: TicketLink): Promise<void> {
    await this.trello('POST', `/cards/${id}/attachments`, { url: link.url, name: link.title });
  }

  async comment(id: string, markdown: string): Promise<{ commentId: string; url?: string }> {
    const a = await this.trello<TrelloAction>('POST', `/cards/${id}/actions/comments`, { text: markdown });
    return { commentId: a.id };
  }

  async listComments(id: string): Promise<TicketComment[]> {
    const actions = await this.trello<TrelloAction[]>('GET', `/cards/${id}/actions`, { filter: 'commentCard', limit: '100' });
    return actions.map((a) => ({
      id: a.id,
      author: a.memberCreator?.username ?? 'unknown',
      markdown: a.data?.text ?? '',
      createdAt: a.date,
    }));
  }

  /**
   * Trello "status" is the list a card sits in; the primary transitions are the
   * board's open lists (moving lists = changing status). Trello also has a
   * card-level `dueComplete` flag — the "mark complete" checkmark in the UI —
   * that is independent of the list. We expose it as one extra synthetic
   * transition so a factory `TICKET_STATUS_DONE` synonym like "Done"/"Complete"
   * resolves even on a board with no list named that. Its id is the literal
   * `dueComplete`, which can never collide with a Trello list id (those are 24-hex).
   */
  async transitions(id: string): Promise<TicketTransition[]> {
    const card = await this.trello<TrelloCard>('GET', `/cards/${id}`, { fields: 'idBoard,idList' });
    const lists = await this.boardLists(card.idBoard);
    const listTransitions = lists.map((l) => ({ id: l.id, name: l.name, toStatus: l.name }));
    return [...listTransitions, { id: DUE_COMPLETE_ID, name: 'Mark complete', toStatus: 'Complete' }];
  }

  /**
   * Apply a transition. The synthetic `dueComplete` transition flips the card's
   * "mark complete" checkmark (leaving it in its current list); every other
   * transitionId is a target list id and moves the card there.
   */
  async transition(id: string, transitionId: string): Promise<void> {
    if (transitionId === DUE_COMPLETE_ID) {
      await this.trello('PUT', `/cards/${id}`, { dueComplete: 'true' });
      return;
    }
    await this.trello('PUT', `/cards/${id}`, { idList: transitionId });
  }

  async assign(id: string, assignee: string | null): Promise<void> {
    if (assignee === null) {
      // Remove every current member (Trello has no "set members" call).
      const card = await this.trello<TrelloCard>('GET', `/cards/${id}`, { fields: 'idMembers' });
      for (const m of card.idMembers) await this.trello('DELETE', `/cards/${id}/idMembers/${m}`);
      return;
    }
    // POST adds a member; Trello silently drops an id that can't join the board (hint, not guarantee).
    await this.trello('POST', `/cards/${id}/idMembers`, { value: assignee });
  }
}
