import type {
  Preflight, Ticket, TicketBucket, TicketComment, TicketLink, TicketListQuery,
  TicketProvider, TicketProviderCapabilities, TicketTransition,
} from '@asf/shared';
import { preflightFailure } from '../rejected.js';

/**
 * GitHub Issues as a TicketProvider. One token (repo + issues scopes) covers
 * this and the SCM provider. Talks to the REST API directly over fetch — no gh
 * CLI dependency, so it runs unchanged in a container. The api is the only
 * process that holds GITHUB_TOKEN; agents never see it.
 *
 * Identity mapping:
 *   id  = key = "owner/repo#123"  (opaque handle; parsed back into repo+number for calls)
 *   url = issue.html_url          (copied, never constructed)
 * Bucket:  GITHUB_BUCKET_MAP label rules first, else open→backlog / closed→done.
 * Priority: a `priority:N` (or `p0..p4`) label, 1 = highest.
 */

export interface GithubTicketConfig {
  token: string;
  repos: string[];          // ["owner/repo", ...]
  bucketMap: Array<{ label: string; bucket: TicketBucket }>;
  apiUrl: string;           // https://api.github.com
}

const H = '## Links';
const PRIORITY_LABELS = /^(?:priority[:/\s-]*|p)([0-5])\b/i;

interface GhLabel { name: string }
interface GhUser { login: string }
interface GhIssue {
  number: number; title: string; body: string | null; html_url: string;
  state: 'open' | 'closed'; state_reason?: string | null;
  labels: Array<GhLabel | string>; assignee: GhUser | null; assignees?: GhUser[]; updated_at: string;
  pull_request?: unknown; // present on issues that are actually PRs — excluded
  repository_url?: string;
}
interface GhComment { id: number; user: GhUser | null; body: string; created_at: string }

/** "owner/repo#123" → { owner, repo, number, repoPath } */
export function parseTicketId(id: string): { owner: string; repo: string; number: number; repoPath: string } {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id.trim());
  if (!m) throw new Error(`not a GitHub issue id (owner/repo#n): ${id}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]), repoPath: `${m[1]}/${m[2]}` };
}

const labelNames = (labels: GhIssue['labels']): string[] =>
  labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);

/** Pages of 100 read per repo per list: 1,000 issues+PRs, far past any real backlog screen. */
export const MAX_ISSUE_PAGES = 10;

export function bucketOf(issue: Pick<GhIssue, 'state' | 'labels'>, map: GithubTicketConfig['bucketMap']): TicketBucket {
  const names = labelNames(issue.labels).map((n) => n.toLowerCase());
  for (const rule of map) if (names.includes(rule.label.toLowerCase())) return rule.bucket;
  return issue.state === 'closed' ? 'done' : 'backlog';
}

export function priorityOf(labels: GhIssue['labels']): number | null {
  for (const name of labelNames(labels)) {
    const m = PRIORITY_LABELS.exec(name);
    if (m) { const n = Number(m[1]); return n >= 1 && n <= 5 ? n : n === 0 ? 1 : null; }
  }
  return null;
}

/** Parse the `## Links` section of a body into TicketLinks (markdown bullet list of [title](url)). */
export function parseLinks(body: string | null): TicketLink[] {
  if (!body) return [];
  const idx = body.indexOf(H);
  if (idx < 0) return [];
  const section = body.slice(idx + H.length);
  const links: TicketLink[] = [];
  for (const line of section.split('\n')) {
    if (/^\s*#/.test(line) && !line.includes(H)) break; // next heading ends the section
    const m = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/.exec(line);
    if (m) links.push({ title: m[1], url: m[2], kind: 'other' });
  }
  return links;
}

/** Task-list checkboxes "- [ ] title" / "- [x] title" in the body → child handles (best-effort). */
export function parseSubtasks(repoPath: string, body: string | null): { open: number; total: number } {
  if (!body) return { open: 0, total: 0 };
  let open = 0, total = 0;
  for (const line of body.split('\n')) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+/.exec(line);
    if (m) { total++; if (m[1] === ' ') open++; }
  }
  return { open, total };
}

export function parseBucketMap(raw: string): GithubTicketConfig['bucketMap'] {
  const valid: TicketBucket[] = ['backlog', 'ready', 'inflight', 'review', 'blocked', 'done'];
  const out: GithubTicketConfig['bucketMap'] = [];
  for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.lastIndexOf('=');
    if (eq < 0) continue;
    const label = pair.slice(0, eq).trim();
    const bucket = pair.slice(eq + 1).trim() as TicketBucket;
    if (label && valid.includes(bucket)) out.push({ label, bucket });
  }
  return out;
}

export class GithubTicketProvider implements TicketProvider {
  readonly kind = 'github' as const;
  private readonly cfg: GithubTicketConfig;

  constructor(cfg: GithubTicketConfig) {
    this.cfg = cfg;
  }

  private async gh<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  }

  private toTicket(repoPath: string, issue: GhIssue): Ticket {
    const subs = parseSubtasks(repoPath, issue.body ?? '');
    return {
      id: `${repoPath}#${issue.number}`,
      key: `${repoPath}#${issue.number}`,
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? '',
      status: issue.state === 'closed' ? 'Closed' : 'Open',
      bucket: bucketOf(issue, this.cfg.bucketMap),
      priority: priorityOf(issue.labels),
      assignee: issue.assignee?.login ?? null,
      labels: labelNames(issue.labels),
      links: parseLinks(issue.body),
      parentId: null,
      children: subs.total > 0 ? Array.from({ length: subs.total }, (_, i) => `${repoPath}#${issue.number}:sub${i + 1}`) : [],
      updatedAt: issue.updated_at,
    };
  }

  async preflight(): Promise<Preflight> {
    if (!this.cfg.token) return { ok: false, reason: 'GITHUB_TOKEN is empty' };
    if (this.cfg.repos.length === 0) return { ok: false, reason: 'GITHUB_REPOS is empty (no owner/repo to read)' };
    try {
      const me = await this.gh<{ login: string }>('GET', '/user');
      // Confirm every configured repo is reachable with this token.
      for (const rp of this.cfg.repos) await this.gh('GET', `/repos/${rp}`);
      return { ok: true, identity: me.login };
    } catch (e) {
      return preflightFailure('GitHub', e);
    }
  }

  capabilities(): TicketProviderCapabilities {
    // GitHub Issues has no boards or sprints (Projects v2 is a possible later
    // map); scoping is by repo, handled through q.scope, not board discovery.
    return { subtasks: true, priority: true, links: true, transitions: true, assignable: true, boards: false, sprints: false, statuses: false };
  }

  // Backlog-scoping discovery is unsupported — capabilities().boards/sprints/statuses
  // are false and these throw, so a caller that ignored the gate fails loudly.
  async listScopes(): Promise<never> { throw new Error('github: board discovery not supported'); }
  async listSprints(): Promise<never> { throw new Error('github: sprints not supported'); }
  async listStatuses(): Promise<never> { throw new Error('github: status discovery not supported'); }

  /** A GitHub issue lives in its own repo — suggest binding to that repo. */
  suggestedRepo(ticket: Ticket): string | null {
    try { return parseTicketId(ticket.id).repoPath; } catch { return null; }
  }

  async list(q: TicketListQuery): Promise<{ tickets: Ticket[]; next?: string }> {
    const scope = q.scope.length ? q.scope : this.cfg.repos;
    // Only open issues can be active work, unless a label rule can put a closed issue in
    // a non-done bucket. Then (and for the Done list) every state is needed.
    const state = q.excludeDone && this.cfg.bucketMap.length === 0 ? 'open' : 'all';
    // The recent window is pushed down (`since` = updated at or after), so the Done list
    // doesn't page through years of closed issues.
    const since = q.updatedWithinDays && q.updatedWithinDays > 0
      ? `&since=${new Date(Date.now() - q.updatedWithinDays * 86_400_000).toISOString()}` : '';
    const all: Ticket[] = [];
    for (const repoPath of scope) {
      // GitHub's issues endpoint returns pull requests too, and they count toward the
      // 100-per-page. One page on an active repo can be mostly PRs and hide older
      // open issues, so follow every page (bounded) and drop the PRs.
      for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
        const issues = await this.gh<GhIssue[]>(
          'GET',
          `/repos/${repoPath}/issues?state=${state}&per_page=100&sort=updated&direction=desc&page=${page}${since}`,
        );
        for (const issue of issues) {
          if (issue.pull_request) continue;
          all.push(this.toTicket(repoPath, issue));
        }
        if (issues.length < 100) break;
      }
    }
    let out = all;
    // GitHub Issues has no server push-down for these (state=all is required so
    // label-mapped buckets stay reachable), so filter the fetched set — mirroring
    // Jira's project path. excludeDone drops finished work; updatedWithinDays is
    // the recent-window the Backlog uses for its Done section.
    if (q.excludeDone) out = out.filter((t) => t.bucket !== 'done');
    if (q.updatedWithinDays && q.updatedWithinDays > 0) {
      const cutoff = Date.now() - q.updatedWithinDays * 86_400_000;
      out = out.filter((t) => Date.parse(t.updatedAt) >= cutoff);
    }
    if (q.bucket?.length) out = out.filter((t) => q.bucket!.includes(t.bucket));
    if (q.search) out = out.filter((t) => t.title.toLowerCase().includes(q.search!.toLowerCase()));
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { tickets: out.slice(0, q.limit) };
  }

  async get(id: string): Promise<Ticket> {
    const { repoPath, number } = parseTicketId(id);
    const issue = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${number}`);
    return this.toTicket(repoPath, issue);
  }

  async update(id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>): Promise<Ticket> {
    const { repoPath, number } = parseTicketId(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.labels !== undefined) body.labels = patch.labels;
    // priority is expressed as a `priority:N` label; translate when asked.
    if (patch.priority !== undefined && patch.priority !== null) {
      const current = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${number}`);
      const kept = labelNames(current.labels).filter((n) => !PRIORITY_LABELS.test(n));
      body.labels = [...kept, `priority:${patch.priority}`];
    }
    const updated = await this.gh<GhIssue>('PATCH', `/repos/${repoPath}/issues/${number}`, body);
    return this.toTicket(repoPath, updated);
  }

  async createSubtask(parentId: string, input: { title: string; body?: string }): Promise<Ticket> {
    const { repoPath } = parseTicketId(parentId);
    // A subtask is a new issue in the same repo, linked back to the parent.
    const created = await this.gh<GhIssue>('POST', `/repos/${repoPath}/issues`, {
      title: input.title,
      body: `${input.body ?? ''}\n\nParent: ${parentId}`.trim(),
    });
    // Append a task-list line to the parent so the checkbox convention is preserved.
    const parent = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${parseTicketId(parentId).number}`);
    const parentBody = `${parent.body ?? ''}\n- [ ] ${input.title} (#${created.number})`.trim();
    await this.gh('PATCH', `/repos/${repoPath}/issues/${parseTicketId(parentId).number}`, { body: parentBody });
    const t = this.toTicket(repoPath, created);
    return { ...t, parentId };
  }

  async addLink(id: string, link: TicketLink): Promise<void> {
    const { repoPath, number } = parseTicketId(id);
    const issue = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${number}`);
    const body = issue.body ?? '';
    const line = `- [${link.title}](${link.url})`;
    let next: string;
    if (body.includes(H)) {
      // Insert under the existing heading.
      const idx = body.indexOf(H) + H.length;
      next = `${body.slice(0, idx)}\n${line}${body.slice(idx)}`;
    } else {
      next = `${body}\n\n${H}\n${line}`;
    }
    await this.gh('PATCH', `/repos/${repoPath}/issues/${number}`, { body: next });
  }

  async comment(id: string, markdown: string): Promise<{ commentId: string; url?: string }> {
    const { repoPath, number } = parseTicketId(id);
    const c = await this.gh<{ id: number; html_url: string }>(
      'POST', `/repos/${repoPath}/issues/${number}/comments`, { body: markdown },
    );
    return { commentId: String(c.id), url: c.html_url };
  }

  async listComments(id: string): Promise<TicketComment[]> {
    const { repoPath, number } = parseTicketId(id);
    const cs = await this.gh<GhComment[]>('GET', `/repos/${repoPath}/issues/${number}/comments?per_page=100`);
    return cs.map((c) => ({ id: String(c.id), author: c.user?.login ?? 'unknown', markdown: c.body, createdAt: c.created_at }));
  }

  async transitions(id: string): Promise<TicketTransition[]> {
    const { repoPath, number } = parseTicketId(id);
    const issue = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${number}`);
    // GitHub has no state machine beyond open/closed; expose those plus any bucket-map label moves.
    const base: TicketTransition[] = issue.state === 'open'
      ? [{ id: 'close', name: 'Close', toStatus: 'Closed' }]
      : [{ id: 'reopen', name: 'Reopen', toStatus: 'Open' }];
    for (const rule of this.cfg.bucketMap) {
      base.push({ id: `label:${rule.label}`, name: `Set label "${rule.label}"`, toStatus: rule.bucket });
    }
    return base;
  }

  async transition(id: string, transitionId: string): Promise<void> {
    const { repoPath, number } = parseTicketId(id);
    if (transitionId === 'close') { await this.gh('PATCH', `/repos/${repoPath}/issues/${number}`, { state: 'closed' }); return; }
    if (transitionId === 'reopen') { await this.gh('PATCH', `/repos/${repoPath}/issues/${number}`, { state: 'open' }); return; }
    if (transitionId.startsWith('label:')) {
      const target = transitionId.slice('label:'.length);
      const issue = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${number}`);
      const ruleLabels = this.cfg.bucketMap.map((r) => r.label.toLowerCase());
      const kept = labelNames(issue.labels).filter((n) => !ruleLabels.includes(n.toLowerCase()));
      await this.gh('PATCH', `/repos/${repoPath}/issues/${number}`, { labels: [...kept, target] });
      return;
    }
    throw new Error(`unknown transition ${transitionId}`);
  }

  async assign(id: string, assignee: string | null): Promise<void> {
    const { repoPath, number } = parseTicketId(id);
    if (assignee === null) {
      // GitHub has no "set assignees to empty" call; clear the current ones.
      const issue = await this.gh<GhIssue>('GET', `/repos/${repoPath}/issues/${number}`);
      const logins = (issue.assignees ?? []).map((a) => a.login);
      if (logins.length) await this.gh('DELETE', `/repos/${repoPath}/issues/${number}/assignees`, { assignees: logins });
      return;
    }
    // POST /assignees adds; GitHub silently ignores a login without repo access.
    await this.gh('POST', `/repos/${repoPath}/issues/${number}/assignees`, { assignees: [assignee] });
  }
}
