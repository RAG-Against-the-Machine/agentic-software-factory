import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrelloTicketProvider, parseListBucketMap, bucketOf, type TrelloTicketConfig } from './trello.js';

// --- recorded fixtures (trimmed real Trello REST shapes) ---
const LISTS = [
  { id: 'L1', name: 'Backlog', pos: 1 },
  { id: 'L2', name: 'Doing', pos: 2 },
  { id: 'L3', name: 'Done', pos: 3 },
];
const CARD_DOING = {
  id: '65abc0000000000000000001', idShort: 42, name: 'Wire up billing', desc: 'Stripe checkout.',
  shortUrl: 'https://trello.com/c/abcd1234', idList: 'L2', idMembers: ['M1'], idBoard: 'B1',
  labels: [{ id: 'lab1', name: 'backend' }], dateLastActivity: '2026-09-16T10:00:00Z',
  attachments: [{ id: 'a1', name: 'Spec', url: 'https://example.com/spec' }, { id: 'a2', name: 'file', url: 'x/not-a-url' }],
};
const CARD_DONE = {
  id: '65abc0000000000000000002', idShort: 7, name: 'Old task', desc: '', shortUrl: 'https://trello.com/c/zzz',
  idList: 'L3', idMembers: [], idBoard: 'B1', labels: [], dateLastActivity: '2026-09-01T00:00:00Z', attachments: [],
};

const cfg = (over: Partial<TrelloTicketConfig> = {}): TrelloTicketConfig => ({
  key: 'k', token: 't', boards: ['B1'], listBucketMap: parseListBucketMap('Doing=inflight'), ...over,
});

/** Stub global.fetch with a method+path router. Trello URLs carry ?key=&token=, so match on the pathname. */
function stubFetch(routes: Array<{ m: string; re: RegExp; status?: number; json?: unknown }>) {
  const calls: Array<{ method: string; url: string; path: string; query: URLSearchParams; body: unknown }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = new URL(String(url));
    calls.push({ method, url: String(url), path: u.pathname, query: u.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes.find((x) => x.m === method && x.re.test(u.pathname));
    if (!r) throw new Error(`no stub for ${method} ${u.pathname}`);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json, text: async () => JSON.stringify(r.json) } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// ---------------------------------------------------------------- pure logic
test('parseListBucketMap parses listName=bucket rules and drops invalid buckets', () => {
  assert.deepEqual(parseListBucketMap('Doing=inflight, Review=review, Junk=nonsense'),
    [{ list: 'Doing', bucket: 'inflight' }, { list: 'Review', bucket: 'review' }]);
  assert.deepEqual(parseListBucketMap(''), []);
});

test('bucketOf: explicit rule wins, else first→backlog / last→done / middle→inflight', () => {
  const map = parseListBucketMap('Doing=inflight');
  assert.equal(bucketOf('L2', LISTS, map), 'inflight', 'explicit rule');
  assert.equal(bucketOf('L1', LISTS, []), 'backlog', 'first list heuristic');
  assert.equal(bucketOf('L3', LISTS, []), 'done', 'last list heuristic');
  const four = [...LISTS.slice(0, 2), { id: 'LX', name: 'Review', pos: 2.5 }, LISTS[2]];
  assert.equal(bucketOf('LX', four, []), 'inflight', 'middle list heuristic');
  assert.equal(bucketOf('unknown', LISTS, map), 'backlog', 'unknown list → backlog');
});

// ----------------------------------------------------- provider over stubbed fetch
test('list maps cards to tickets: key/url/status/bucket/labels/links', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/boards\/B1\/lists$/, json: LISTS },
    { m: 'GET', re: /\/boards\/B1\/cards$/, json: [CARD_DOING, CARD_DONE] },
  ]);
  try {
    const { tickets } = await new TrelloTicketProvider(cfg()).list({ scope: ['B1'], limit: 50 });
    assert.equal(tickets.length, 2);
    const doing = tickets.find((t) => t.key === '#42')!;
    assert.equal(doing.id, '65abc0000000000000000001');
    assert.equal(doing.url, 'https://trello.com/c/abcd1234');
    assert.equal(doing.status, 'Doing');
    assert.equal(doing.bucket, 'inflight');
    assert.equal(doing.priority, null);
    assert.equal(doing.assignee, 'M1');
    assert.deepEqual(doing.labels, ['backend']);
    assert.deepEqual(doing.links, [{ title: 'Spec', url: 'https://example.com/spec', kind: 'other' }], 'only http(s) attachments become links');
    const done = tickets.find((t) => t.key === '#7')!;
    assert.equal(done.bucket, 'done');
    assert.equal(done.assignee, null);
  } finally { s.restore(); }
});

test('list applies bucket filter and passes key+token as query auth', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/boards\/B1\/lists$/, json: LISTS },
    { m: 'GET', re: /\/boards\/B1\/cards$/, json: [CARD_DOING, CARD_DONE] },
  ]);
  try {
    const { tickets } = await new TrelloTicketProvider(cfg()).list({ scope: ['B1'], bucket: ['done'], limit: 50 });
    assert.deepEqual(tickets.map((t) => t.key), ['#7']);
    const call = s.calls.find((c) => c.path.endsWith('/cards'))!;
    assert.equal(call.query.get('key'), 'k');
    assert.equal(call.query.get('token'), 't');
  } finally { s.restore(); }
});

test('get fetches a card and its board lists to resolve status', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/cards\/65abc0000000000000000001$/, json: CARD_DOING },
    { m: 'GET', re: /\/boards\/B1\/lists$/, json: LISTS },
  ]);
  try {
    const t = await new TrelloTicketProvider(cfg()).get('65abc0000000000000000001');
    assert.equal(t.status, 'Doing');
    assert.equal(t.bucket, 'inflight');
  } finally { s.restore(); }
});

test('transitions() returns the board lists plus a synthetic "mark complete"', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/cards\/C1$/, json: { idBoard: 'B1', idList: 'L2' } },
    { m: 'GET', re: /\/boards\/B1\/lists$/, json: LISTS },
  ]);
  try {
    const trs = await new TrelloTicketProvider(cfg()).transitions('C1');
    assert.deepEqual(trs, [
      { id: 'L1', name: 'Backlog', toStatus: 'Backlog' },
      { id: 'L2', name: 'Doing', toStatus: 'Doing' },
      { id: 'L3', name: 'Done', toStatus: 'Done' },
      { id: 'dueComplete', name: 'Mark complete', toStatus: 'Complete' },
    ]);
  } finally { s.restore(); }
});

test('transition(id, listId) PUTs the target idList', async () => {
  const s = stubFetch([{ m: 'PUT', re: /\/cards\/C1$/, json: {} }]);
  try {
    await new TrelloTicketProvider(cfg()).transition('C1', 'L3');
    assert.equal(s.calls.at(-1)!.query.get('idList'), 'L3');
  } finally { s.restore(); }
});

test('transition(id, "dueComplete") flips the card\'s complete flag, not its list', async () => {
  const s = stubFetch([{ m: 'PUT', re: /\/cards\/C1$/, json: {} }]);
  try {
    await new TrelloTicketProvider(cfg()).transition('C1', 'dueComplete');
    const call = s.calls.at(-1)!;
    assert.equal(call.query.get('dueComplete'), 'true');
    assert.equal(call.query.get('idList'), null, 'a mark-complete does not move the card');
  } finally { s.restore(); }
});

test('assign adds a member; assign(null) removes each current member', async () => {
  const add = stubFetch([{ m: 'POST', re: /\/cards\/C1\/idMembers$/, json: {} }]);
  try {
    await new TrelloTicketProvider(cfg()).assign('C1', 'M9');
    assert.equal(add.calls.at(-1)!.query.get('value'), 'M9');
  } finally { add.restore(); }

  const del = stubFetch([
    { m: 'GET', re: /\/cards\/C1$/, json: { idMembers: ['M1', 'M2'] } },
    { m: 'DELETE', re: /\/cards\/C1\/idMembers\/M1$/, json: {} },
    { m: 'DELETE', re: /\/cards\/C1\/idMembers\/M2$/, json: {} },
  ]);
  try {
    await new TrelloTicketProvider(cfg()).assign('C1', null);
    const deletes = del.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    assert.deepEqual(deletes, ['/1/cards/C1/idMembers/M1', '/1/cards/C1/idMembers/M2']);
  } finally { del.restore(); }
});

test('addLink POSTs an attachment; comment POSTs a comment action', async () => {
  const s = stubFetch([
    { m: 'POST', re: /\/cards\/C1\/attachments$/, json: {} },
    { m: 'POST', re: /\/cards\/C1\/actions\/comments$/, json: { id: 'act1' } },
  ]);
  try {
    const p = new TrelloTicketProvider(cfg());
    await p.addLink('C1', { title: 'Doc', url: 'https://x.dev/d', kind: 'doc' });
    const att = s.calls.find((c) => c.path.endsWith('/attachments'))!;
    assert.equal(att.query.get('url'), 'https://x.dev/d');
    assert.equal(att.query.get('name'), 'Doc');
    const res = await p.comment('C1', 'hello');
    assert.equal(res.commentId, 'act1');
  } finally { s.restore(); }
});

test('createSubtask throws (capability is false)', async () => {
  await assert.rejects(() => new TrelloTicketProvider(cfg()).createSubtask(), /subtasks not supported/);
});

test('capabilities: no subtasks, no priority; links/transitions/assignable on', () => {
  assert.deepEqual(new TrelloTicketProvider(cfg()).capabilities(),
    { subtasks: false, priority: false, links: true, transitions: true, assignable: true, boards: false, sprints: false, statuses: false });
});

test('preflight fails clearly on empty creds / boards, else returns username', async () => {
  assert.deepEqual(await new TrelloTicketProvider(cfg({ key: '' })).preflight(),
    { ok: false, reason: 'TRELLO_KEY and TRELLO_TOKEN must both be set' });
  assert.deepEqual(await new TrelloTicketProvider(cfg({ boards: [] })).preflight(),
    { ok: false, reason: 'TRELLO_BOARDS is empty (no board id to read)' });

  const s = stubFetch([
    { m: 'GET', re: /\/members\/me$/, json: { id: 'M1', username: 'jonarme' } },
    { m: 'GET', re: /\/boards\/B1$/, json: { id: 'B1' } },
  ]);
  try {
    assert.deepEqual(await new TrelloTicketProvider(cfg()).preflight(), { ok: true, identity: 'jonarme' });
  } finally { s.restore(); }
});
