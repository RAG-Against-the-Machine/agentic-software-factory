import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GithubTicketProvider, bucketOf, priorityOf, parseLinks, parseSubtasks,
  parseTicketId, parseBucketMap, type GithubTicketConfig,
} from './github.js';

// --- recorded fixtures (trimmed real GitHub REST shapes) ---
const ISSUE_OPEN = {
  number: 42,
  title: 'Add rate limiting to the API',
  body: 'We need a token bucket.\n\n- [x] design\n- [ ] implement\n- [ ] test\n\n## Links\n- [Design doc](https://example.com/doc)\n',
  html_url: 'https://github.com/acme/widgets/issues/42',
  state: 'open',
  labels: [{ name: 'status:in progress' }, { name: 'priority:2' }],
  assignee: { login: 'octocat' },
  updated_at: '2026-09-14T12:00:00Z',
};
const ISSUE_CLOSED = {
  number: 7, title: 'Old bug', body: '', html_url: 'https://github.com/acme/widgets/issues/7',
  state: 'closed', labels: [], assignee: null, updated_at: '2026-09-01T00:00:00Z',
};
const A_PR = { ...ISSUE_CLOSED, number: 99, pull_request: { url: 'x' } };

const cfg = (over: Partial<GithubTicketConfig> = {}): GithubTicketConfig => ({
  token: 't', repos: ['acme/widgets'], apiUrl: 'https://api.github.com',
  bucketMap: parseBucketMap('status:in progress=inflight,status:review=review'),
  ...over,
});

// Stub global.fetch with a router over method+path; returns recorded JSON.
function stubFetch(routes: Array<{ m: string; re: RegExp; status?: number; json?: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes.find((x) => x.m === method && x.re.test(String(url)));
    if (!r) throw new Error(`no stub for ${method} ${url}`);
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      json: async () => r.json, text: async () => JSON.stringify(r.json),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

// ---------------------------------------------------------------- pure logic
test('parseTicketId splits owner/repo#n and rejects junk', () => {
  assert.deepEqual(parseTicketId('acme/widgets#42'), { owner: 'acme', repo: 'widgets', number: 42, repoPath: 'acme/widgets' });
  assert.throws(() => parseTicketId('nope'));
  assert.throws(() => parseTicketId('acme/widgets'));
});

test('parseBucketMap parses label=bucket rules and drops invalid buckets', () => {
  assert.deepEqual(parseBucketMap('status:review=review, foo=nonsense, s:blocked=blocked'),
    [{ label: 'status:review', bucket: 'review' }, { label: 's:blocked', bucket: 'blocked' }]);
  assert.deepEqual(parseBucketMap(''), []);
});

test('bucketOf: label rule wins, else open→backlog / closed→done', () => {
  const map = parseBucketMap('status:in progress=inflight');
  assert.equal(bucketOf({ state: 'open', labels: [{ name: 'status:in progress' }] }, map), 'inflight');
  assert.equal(bucketOf({ state: 'open', labels: [] }, map), 'backlog');
  assert.equal(bucketOf({ state: 'closed', labels: [] }, map), 'done');
  // case-insensitive label match
  assert.equal(bucketOf({ state: 'open', labels: ['Status:In Progress'] }, map), 'inflight');
});

test('priorityOf reads priority:N and pN labels, 1=highest, p0→1', () => {
  assert.equal(priorityOf([{ name: 'priority:2' }]), 2);
  assert.equal(priorityOf(['p1']), 1);
  assert.equal(priorityOf(['p0']), 1);
  assert.equal(priorityOf([{ name: 'bug' }]), null);
});

test('parseLinks reads the ## Links section only', () => {
  const links = parseLinks(ISSUE_OPEN.body);
  assert.deepEqual(links, [{ title: 'Design doc', url: 'https://example.com/doc', kind: 'other' }]);
  assert.deepEqual(parseLinks('no links here'), []);
});

test('parseSubtasks counts task-list checkboxes', () => {
  assert.deepEqual(parseSubtasks('acme/widgets', ISSUE_OPEN.body), { open: 2, total: 3 });
  assert.deepEqual(parseSubtasks('acme/widgets', ''), { open: 0, total: 0 });
});

// ----------------------------------------------------- provider over stubbed fetch
test('list maps issues to tickets, excludes PRs, applies bucket filter', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/repos\/acme\/widgets\/issues\?/, json: [ISSUE_OPEN, ISSUE_CLOSED, A_PR] }]);
  try {
    const p = new GithubTicketProvider(cfg());
    const { tickets } = await p.list({ scope: ['acme/widgets'], limit: 50 });
    assert.equal(tickets.length, 2, 'PR excluded');
    const open = tickets.find((t) => t.key === 'acme/widgets#42')!;
    assert.equal(open.bucket, 'inflight');
    assert.equal(open.priority, 2);
    assert.equal(open.assignee, 'octocat');
    assert.equal(open.children.length, 3);
    assert.deepEqual(open.links, [{ title: 'Design doc', url: 'https://example.com/doc', kind: 'other' }]);

    const only = await p.list({ scope: ['acme/widgets'], bucket: ['done'], limit: 50 });
    assert.deepEqual(only.tickets.map((t) => t.key), ['acme/widgets#7']);
  } finally { s.restore(); }
});

test('list excludeDone drops the done bucket; updatedWithinDays keeps the recent window', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/repos\/acme\/widgets\/issues\?/, json: [ISSUE_OPEN, ISSUE_CLOSED] }]);
  try {
    const p = new GithubTicketProvider(cfg());
    // excludeDone: the closed (done-bucket) issue must not appear in the active list.
    const active = await p.list({ scope: ['acme/widgets'], excludeDone: true, limit: 50 });
    assert.deepEqual(active.tickets.map((t) => t.key), ['acme/widgets#42'], 'done issue excluded');
    // updatedWithinDays: ISSUE_CLOSED (updated 2026-09-01) is outside a 7-day window anchored on ISSUE_OPEN (2026-09-14).
    const nowStub = () => new Date('2026-09-15T00:00:00Z').getTime();
    const origNow = Date.now;
    Date.now = nowStub;
    try {
      const recent = await p.list({ scope: ['acme/widgets'], updatedWithinDays: 7, limit: 50 });
      assert.deepEqual(recent.tickets.map((t) => t.key), ['acme/widgets#42'], 'stale issue outside window');
    } finally { Date.now = origNow; }
  } finally { s.restore(); }
});

test('get fetches one issue and maps id/key/url', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/repos\/acme\/widgets\/issues\/42$/, json: ISSUE_OPEN }]);
  try {
    const t = await new GithubTicketProvider(cfg()).get('acme/widgets#42');
    assert.equal(t.id, 'acme/widgets#42');
    assert.equal(t.key, 'acme/widgets#42');
    assert.equal(t.url, 'https://github.com/acme/widgets/issues/42');
  } finally { s.restore(); }
});

test('update priority translates to a priority:N label, dropping the old one', async () => {
  const s = stubFetch([
    { m: 'GET', re: /issues\/42$/, json: ISSUE_OPEN },
    { m: 'PATCH', re: /issues\/42$/, json: { ...ISSUE_OPEN, labels: [{ name: 'status:in progress' }, { name: 'priority:1' }] } },
  ]);
  try {
    await new GithubTicketProvider(cfg()).update('acme/widgets#42', { priority: 1 });
    const patch = s.calls.find((c) => c.method === 'PATCH')!;
    assert.deepEqual((patch.body as { labels: string[] }).labels, ['status:in progress', 'priority:1']);
  } finally { s.restore(); }
});

test('addLink inserts under an existing ## Links heading', async () => {
  const s = stubFetch([
    { m: 'GET', re: /issues\/42$/, json: ISSUE_OPEN },
    { m: 'PATCH', re: /issues\/42$/, json: ISSUE_OPEN },
  ]);
  try {
    await new GithubTicketProvider(cfg()).addLink('acme/widgets#42', { title: 'Spec', url: 'https://x.dev/s', kind: 'doc' });
    const body = (s.calls.find((c) => c.method === 'PATCH')!.body as { body: string }).body;
    assert.match(body, /## Links\n- \[Spec\]\(https:\/\/x\.dev\/s\)/);
    assert.match(body, /Design doc/, 'existing link preserved');
  } finally { s.restore(); }
});

test('addLink creates a ## Links heading when none exists', async () => {
  const s = stubFetch([
    { m: 'GET', re: /issues\/7$/, json: ISSUE_CLOSED },
    { m: 'PATCH', re: /issues\/7$/, json: ISSUE_CLOSED },
  ]);
  try {
    await new GithubTicketProvider(cfg()).addLink('acme/widgets#7', { title: 'A', url: 'https://a.dev', kind: 'other' });
    const body = (s.calls.find((c) => c.method === 'PATCH')!.body as { body: string }).body;
    assert.match(body, /## Links\n- \[A\]\(https:\/\/a\.dev\)/);
  } finally { s.restore(); }
});

test('transition close/reopen and label move', async () => {
  const s = stubFetch([
    { m: 'PATCH', re: /issues\/42$/, json: ISSUE_OPEN },
    { m: 'GET', re: /issues\/42$/, json: ISSUE_OPEN },
  ]);
  try {
    const p = new GithubTicketProvider(cfg());
    await p.transition('acme/widgets#42', 'close');
    assert.equal((s.calls.at(-1)!.body as { state: string }).state, 'closed');
    await p.transition('acme/widgets#42', 'label:status:review');
    const moved = s.calls.at(-1)!.body as { labels: string[] };
    assert.ok(moved.labels.includes('status:review'));
    assert.ok(!moved.labels.includes('status:in progress'), 'old bucket label removed');
  } finally { s.restore(); }
});

test('preflight fails clearly on empty token / repos', async () => {
  assert.deepEqual(await new GithubTicketProvider(cfg({ token: '' })).preflight(), { ok: false, reason: 'GITHUB_TOKEN is empty' });
  assert.deepEqual(await new GithubTicketProvider(cfg({ repos: [] })).preflight(),
    { ok: false, reason: 'GITHUB_REPOS is empty (no owner/repo to read)' });
});

test('preflight returns login and checks each repo', async () => {
  const s = stubFetch([
    { m: 'GET', re: /\/user$/, json: { login: 'octocat' } },
    { m: 'GET', re: /\/repos\/acme\/widgets$/, json: { full_name: 'acme/widgets' } },
  ]);
  try {
    assert.deepEqual(await new GithubTicketProvider(cfg()).preflight(), { ok: true, identity: 'octocat' });
  } finally { s.restore(); }
});

test('assign POSTs the login to /assignees', async () => {
  const s = stubFetch([{ m: 'POST', re: /\/repos\/acme\/widgets\/issues\/42\/assignees$/, json: {} }]);
  try {
    await new GithubTicketProvider(cfg()).assign('acme/widgets#42', 'asf-bot');
    assert.deepEqual((s.calls.at(-1)!.body as { assignees: string[] }).assignees, ['asf-bot']);
  } finally { s.restore(); }
});

test('assign(null) clears the current assignees via DELETE', async () => {
  const s = stubFetch([
    { m: 'GET', re: /issues\/42$/, json: { ...ISSUE_OPEN, assignees: [{ login: 'octocat' }] } },
    { m: 'DELETE', re: /\/issues\/42\/assignees$/, json: {} },
  ]);
  try {
    await new GithubTicketProvider(cfg()).assign('acme/widgets#42', null);
    const del = s.calls.find((c) => c.method === 'DELETE')!;
    assert.deepEqual((del.body as { assignees: string[] }).assignees, ['octocat']);
  } finally { s.restore(); }
});

test('assign(null) is a no-op when there are no assignees to clear', async () => {
  const s = stubFetch([{ m: 'GET', re: /issues\/7$/, json: { ...ISSUE_CLOSED, assignees: [] } }]);
  try {
    await new GithubTicketProvider(cfg()).assign('acme/widgets#7', null);
    assert.equal(s.calls.some((c) => c.method === 'DELETE'), false);
  } finally { s.restore(); }
});

test('list follows every page: pull requests filling page 1 must not hide older open issues', async () => {
  // Page 1 is 100 items, 99 of them PRs (an active repo); the older open issue is on page 2.
  const prs = Array.from({ length: 99 }, (_, i) => ({ ...A_PR, number: 1000 + i, state: 'open', updated_at: '2026-09-29T00:00:00Z' }));
  const page1 = [{ ...ISSUE_OPEN, number: 500, labels: [], updated_at: '2026-09-29T00:00:00Z' }, ...prs];
  const page2 = [{ ...ISSUE_OPEN, number: 68, labels: [], updated_at: '2026-09-20T00:00:00Z' }];
  const s = stubFetch([
    { m: 'GET', re: /\/issues\?.*&page=1(&|$)/, json: page1 },
    { m: 'GET', re: /\/issues\?.*&page=2(&|$)/, json: page2 },
  ]);
  try {
    const p = new GithubTicketProvider(cfg({ bucketMap: [] }));
    const { tickets } = await p.list({ scope: ['acme/widgets'], excludeDone: true, limit: 200 });
    assert.deepEqual(tickets.map((t) => t.key), ['acme/widgets#500', 'acme/widgets#68']);
    const urls = s.calls.map((c) => c.url);
    assert.equal(urls.length, 2, 'stops after the short page');
    assert.match(urls[0], /state=open/, 'active list with no label rules asks for open issues only');
  } finally { s.restore(); }
});

test('list keeps state=all when a label rule could make a closed issue active; the recent window is pushed down as since=', async () => {
  const s = stubFetch([{ m: 'GET', re: /\/repos\/acme\/widgets\/issues\?/, json: [ISSUE_OPEN] }]);
  try {
    const p = new GithubTicketProvider(cfg());
    await p.list({ scope: ['acme/widgets'], excludeDone: true, limit: 50 });
    assert.match(s.calls[0].url, /state=all/);
    await p.list({ scope: ['acme/widgets'], updatedWithinDays: 7, limit: 50 });
    assert.match(s.calls[1].url, /&since=\d{4}-\d\d-\d\dT/);
  } finally { s.restore(); }
});
