import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repo, ScmProvider, Ticket, TicketProvider } from '@asf/shared';
import { startReadiness, pickRepo } from './start-readiness.js';
import { MockScmProvider } from './providers/scm/mock.js';
import { MockTicketProvider } from './providers/tickets/mock.js';

const repo = (p: string): Repo => ({ id: p, path: p, url: `https://x/${p}`, defaultBranch: 'main', cloneUrl: `https://x/${p}.git` });
function scm(opts: { ok?: boolean; reason?: string; repos?: Repo[]; getRepo?: (id: string) => Repo }): ScmProvider {
  return {
    kind: 'github',
    preflight: async () => (opts.ok === false ? { ok: false, reason: opts.reason ?? 'bad token' } : { ok: true, identity: 'me' }),
    searchRepos: async () => opts.repos ?? [],
    getRepo: async (id: string) => { if (opts.getRepo) return opts.getRepo(id); throw new Error('404'); },
  } as unknown as ScmProvider;
}
const ticket = { id: 't1', key: 'T-1' } as Ticket;
const tickets = (suggested: string | null = null) => ({ suggestedRepo: () => suggested }) as unknown as TicketProvider;

test('nothing can start while source control is not connected; the reason names the fix', async () => {
  const r = await startReadiness(scm({ ok: false, reason: 'GITHUB_TOKEN is empty' }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'scm_not_connected');
  assert.match(r.reason, /GITHUB_TOKEN is empty/);
  assert.equal(r.link, '/settings#code');
});

test('a connected source control with no repository chosen still blocks starting', async () => {
  const r = await startReadiness(scm({ repos: [] }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'no_repos');
});

test('the mock SCM with no MOCK_REPO_PATH is not a repository: a fresh install cannot start', async () => {
  const r = await startReadiness(new MockScmProvider(''));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'scm_not_connected');
  assert.equal((await startReadiness(new MockScmProvider('/some/repo.git'))).ok, true, 'a configured practice repo is reachable');
});

test('pickRepo: the requested repo wins; unknown ones are refused, not guessed', async () => {
  const repos = [repo('a/one'), repo('a/two')];
  const got = await pickRepo({ tickets: tickets(), scm: scm({ repos }) }, ticket, repos, 'a/two');
  assert.ok(got.ok && got.repo.id === 'a/two');
  const bad = await pickRepo({ tickets: tickets(), scm: scm({ repos }) }, ticket, repos, 'a/nope');
  assert.ok(!bad.ok && bad.code === 'repo_not_found');
});

test('pickRepo: else the ticket\'s own repo, else the only one; several and no hint is refused', async () => {
  const repos = [repo('a/one'), repo('a/two')];
  const own = await pickRepo({ tickets: tickets('a/two'), scm: scm({ repos }) }, ticket, repos);
  assert.ok(own.ok && own.repo.id === 'a/two');
  const only = await pickRepo({ tickets: tickets(), scm: scm({ repos: [repos[0]] }) }, ticket, [repos[0]]);
  assert.ok(only.ok && only.repo.id === 'a/one');
  const amb = await pickRepo({ tickets: tickets(), scm: scm({ repos }) }, ticket, repos);
  assert.ok(!amb.ok && amb.code === 'repo_ambiguous');
  assert.match(amb.ok ? '' : amb.reason, /T-1.*a\/one, a\/two/);
});

void MockTicketProvider;
