import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { TicketProvider, ScmProvider } from '@asf/shared';
import { registerSetupRoutes, __resetSetupCaches, type SetupStatus } from './setup.js';
import { TicketProviderRegistry } from '../providers/tickets/registry.js';
import { ScmProviderRegistry } from '../providers/scm/registry.js';

// The setup-status route aggregates the two provider preflights, the agent-auth
// describe, and two registry RPCs (listFleet, listRuns). Stub the registry HTTP
// layer (mirrors admin.test.ts) and drive the providers with fake registries.
const realFetch = global.fetch;
const ENV_KEYS = ['TICKET_PROVIDER', 'SCM_PROVIDER', 'AGENT_AUTH_MODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AUTH_MODE'] as const;
afterEach(() => {
  global.fetch = realFetch;
  __resetSetupCaches(); // the preflight cache is module-level and time-based; reset between tests
  for (const k of ENV_KEYS) delete process.env[k];
});

/** Stub the registry so listFleet/listRuns/getOrgSecret return controllable results. */
function stubRegistry(opts: { workers?: { id: string; authMode: string | null }[]; succeededRuns?: number } = {}) {
  const workers = (opts.workers ?? []).map((w) => ({
    id: w.id, host: 'h', runtimes: ['claude-code'], authMode: w.authMode, maxConcurrent: 1, running: 0, lastHeartbeat: new Date().toISOString(),
  }));
  const runs = Array.from({ length: opts.succeededRuns ?? 0 }, (_, i) => ({ id: `run_${i}` }));
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as { op: string };
    let result: unknown = { ok: true };
    if (body.op === 'listFleet') result = { workers, capacity: workers.length, running: 0 };
    else if (body.op === 'listRuns') result = { runs, total: runs.length };
    else if (body.op === 'getOrgSettings') result = { settings: {} };
    else if (body.op === 'getOrgSecret') result = { value: '' };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function fakeProvider(kind: string, preflight: TicketProvider['preflight']): TicketProvider {
  return {
    kind: kind as TicketProvider['kind'], preflight,
    capabilities() { return { subtasks: false, priority: false, links: false, transitions: false, assignable: false, boards: false, sprints: false, statuses: false }; },
    async list() { return { tickets: [] }; },
    async get() { throw new Error('nope'); },
    async update() { throw new Error('nope'); },
    async createSubtask() { throw new Error('nope'); },
    async addLink() {}, async comment() { return { commentId: 'c' }; },
    async listComments() { return []; }, async transitions() { return []; },
    async transition() {}, async assign() {},
    async listScopes() { return []; }, async listSprints() { return []; }, async listStatuses() { return []; },
  };
}

function fakeScm(kind: string, preflight: ScmProvider['preflight']): ScmProvider {
  return {
    kind: kind as ScmProvider['kind'], preflight,
    async searchRepos() { return []; },
    async getRepo() { throw new Error('nope'); },
    async cloneCredential() { return { url: 'mock://clone' }; },
    async openChangeRequest() { throw new Error('nope'); },
    async listChangeRequests() { return []; },
    async getChangeRequest() { throw new Error('nope'); },
    async listReviewComments() { return []; },
    async comment() {}, async markReady() {}, async merge() {},
  };
}

async function app(tickets: TicketProviderRegistry, scm: ScmProviderRegistry) {
  const a = Fastify();
  registerSetupRoutes(a, { tickets, scm });
  await a.ready();
  return a;
}

const okTickets = () => new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'me@example.com' })), () => 'jira');
const okScm = () => new ScmProviderRegistry(async (k) => fakeScm(k, async () => ({ ok: true, identity: 'octocat' })), () => 'github');
const status = (json: unknown) => json as SetupStatus;
const item = (s: SetupStatus, id: string) => s.items.find((i) => i.id === id)!;

test('all-mock: provider items are not done and setup is incomplete', async () => {
  stubRegistry();
  // No provider env set -> cfg resolves the 'mock' default, no env pin.
  const a = await app(
    new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'x' })), () => 'mock'),
    new ScmProviderRegistry(async (k) => fakeScm(k, async () => ({ ok: true, identity: 'x' })), () => 'mock'),
  );
  const res = await a.inject({ method: 'GET', url: '/api/setup/status' });
  assert.equal(res.statusCode, 200);
  const s = status(res.json());
  assert.equal(item(s, 'ticket').done, false);
  assert.equal(item(s, 'scm').done, false);
  assert.match(item(s, 'ticket').reason!, /sample tickets/i);
  assert.equal(item(s, 'ticket').link, '/settings#tickets', 'links to the question, not the retired /providers page');
  assert.equal(item(s, 'scm').link, '/settings#code');
  assert.equal(item(s, 'worker').link, '/workers');
  assert.equal(item(s, 'ticket').envPinned, false);
  assert.equal(s.complete, false);
  await a.close();
});

test('providers configured and passing preflight: items done with the resolved identity', async () => {
  stubRegistry();
  process.env.TICKET_PROVIDER = 'jira';
  process.env.SCM_PROVIDER = 'github';
  const a = await app(okTickets(), okScm());
  const res = await a.inject({ method: 'GET', url: '/api/setup/status' });
  const s = status(res.json());
  assert.equal(item(s, 'ticket').done, true);
  assert.equal(item(s, 'ticket').identity, 'me@example.com');
  assert.equal(item(s, 'scm').done, true);
  assert.equal(item(s, 'scm').identity, 'octocat');
  await a.close();
});

test('a provider env-pinned to mock is flagged blocked-from-UI', async () => {
  stubRegistry();
  process.env.TICKET_PROVIDER = 'mock';
  const a = await app(
    new TicketProviderRegistry(async (k) => fakeProvider(k, async () => ({ ok: true, identity: 'x' })), () => 'mock'),
    okScm(),
  );
  const res = await a.inject({ method: 'GET', url: '/api/setup/status' });
  const s = status(res.json());
  const ticket = item(s, 'ticket');
  assert.equal(ticket.done, false);
  assert.equal(ticket.envPinned, true);
  assert.match(ticket.reason!, /Pinned to mock by the environment/);
  await a.close();
});

test('item 6 is done once any run has succeeded', async () => {
  stubRegistry({ succeededRuns: 1 });
  const a = await app(okTickets(), okScm());
  const res = await a.inject({ method: 'GET', url: '/api/setup/status' });
  const s = status(res.json());
  assert.equal(item(s, 'first-run').done, true);
  await a.close();
});

test('worker item matches a live worker on the current auth mode', async () => {
  process.env.AGENT_AUTH_MODE = 'api-key';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  stubRegistry({ workers: [{ id: 'w1', authMode: 'api-key' }] });
  const a = await app(okTickets(), okScm());
  const res = await a.inject({ method: 'GET', url: '/api/setup/status' });
  const s = status(res.json());
  assert.equal(item(s, 'worker').done, true);
  assert.match(item(s, 'worker').reason!, /w1/);
  await a.close();
});

test('a worker on the wrong auth mode is reported as a mismatch, not done', async () => {
  process.env.AGENT_AUTH_MODE = 'api-key';
  stubRegistry({ workers: [{ id: 'w1', authMode: 'oauth-token' }] });
  const a = await app(okTickets(), okScm());
  const res = await a.inject({ method: 'GET', url: '/api/setup/status' });
  const s = status(res.json());
  assert.equal(item(s, 'worker').done, false);
  assert.match(item(s, 'worker').reason!, /not api-key/);
  await a.close();
});

// Anthropic's terms: one Claude subscription must not serve several operators.
const asOperator = { 'x-goog-authenticated-user-email': 'accounts.google.com:ada@example.com' };

test('a subscription token on a multi-operator factory carries a terms warning', async () => {
  process.env.AGENT_AUTH_MODE = 'oauth-token';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
  process.env.AUTH_MODE = 'header';
  stubRegistry();
  const a = await app(okTickets(), okScm());
  const res = await a.inject({ method: 'GET', url: '/api/setup/status', headers: asOperator });
  const ai = item(status(res.json()), 'agent-auth');
  assert.equal(ai.done, true, 'a warning never blocks setup');
  assert.match(ai.warning ?? '', /personal use/);
  await a.close();
});

test('no terms warning for a single operator, or for an API key with several', async () => {
  for (const [mode, authMode] of [['oauth-token', 'none'], ['api-key', 'header']] as const) {
    process.env.AGENT_AUTH_MODE = mode;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.AUTH_MODE = authMode;
    stubRegistry();
    const a = await app(okTickets(), okScm());
    const res = await a.inject({ method: 'GET', url: '/api/setup/status', headers: asOperator });
    assert.equal(item(status(res.json()), 'agent-auth').warning, undefined, `${mode} + ${authMode}`);
    await a.close();
  }
});
