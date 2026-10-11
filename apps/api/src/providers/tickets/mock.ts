import type { Ticket, TicketComment, TicketLink, TicketListQuery, TicketProvider, TicketTransition } from '@asf/shared';

const now = () => new Date().toISOString();

export class MockTicketProvider implements TicketProvider {
  readonly kind = 'mock' as const;
  private tickets = new Map<string, Ticket>();
  private comments = new Map<string, TicketComment[]>();

  constructor() {
    const seed: Array<Partial<Ticket> & { key: string; title: string }> = [
      { key: 'ASF-1', title: 'Add TicketProvider for GitHub Issues', bucket: 'ready', priority: 2 },
      { key: 'ASF-2', title: 'Worker: ClaudeCodeRuntime spawn + parse', bucket: 'backlog', priority: 1 },
      { key: 'ASF-3', title: 'Web: Today view', bucket: 'backlog', priority: 3 },
    ];
    for (const s of seed) {
      const id = s.key.toLowerCase();
      this.tickets.set(id, {
        id, key: s.key, url: `mock://tickets/${id}`, title: s.title, body: '', status: 'To Do',
        bucket: s.bucket ?? 'backlog', priority: s.priority ?? null, assignee: null, labels: [], links: [],
        parentId: null, children: [], updatedAt: now(),
      });
    }
  }

  async preflight() { return { ok: true as const, identity: 'mock' }; }
  capabilities() { return { subtasks: true, priority: true, links: true, transitions: true, assignable: true, boards: false, sprints: false, statuses: false }; }
  // Backlog-scoping discovery is off for the mock (flat seed list, no boards);
  // capability-gated methods throw, like createSubtask on a tracker without subtasks.
  async listScopes(): Promise<never> { throw new Error('mock: boards not supported'); }
  async listSprints(): Promise<never> { throw new Error('mock: sprints not supported'); }
  async listStatuses(): Promise<never> { throw new Error('mock: statuses not supported'); }

  async list(q: TicketListQuery) {
    let all = [...this.tickets.values()];
    if (q.bucket?.length) all = all.filter((t) => q.bucket!.includes(t.bucket));
    if (q.search) all = all.filter((t) => t.title.toLowerCase().includes(q.search!.toLowerCase()));
    return { tickets: all.slice(0, q.limit) };
  }
  async get(id: string) { const t = this.tickets.get(id); if (!t) throw new Error(`no ticket ${id}`); return t; }
  async update(id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>) {
    const t = { ...(await this.get(id)), ...patch, updatedAt: now() }; this.tickets.set(id, t); return t;
  }
  async createSubtask(parentId: string, input: { title: string; body?: string }) {
    const parent = await this.get(parentId);
    const id = `${parentId}-${parent.children.length + 1}`;
    const t: Ticket = { ...parent, id, key: id.toUpperCase(), title: input.title, body: input.body ?? '', parentId, children: [], updatedAt: now() };
    this.tickets.set(id, t); parent.children.push(id); return t;
  }
  async addLink(id: string, link: TicketLink) { (await this.get(id)).links.push(link); }
  async comment(id: string, markdown: string) {
    const c: TicketComment = { id: String(Date.now()), author: 'factory', markdown, createdAt: now() };
    this.comments.set(id, [...(this.comments.get(id) ?? []), c]); return { commentId: c.id };
  }
  async listComments(id: string) { return this.comments.get(id) ?? []; }
  async transitions(): Promise<TicketTransition[]> {
    return [{ id: 'start', name: 'Start', toStatus: 'In Progress' }, { id: 'done', name: 'Done', toStatus: 'Done' }];
  }
  async transition(id: string, transitionId: string) {
    const t = await this.get(id); t.status = transitionId === 'done' ? 'Done' : 'In Progress';
    t.bucket = transitionId === 'done' ? 'done' : 'inflight';
  }
  async assign(id: string, assignee: string | null) {
    const t = await this.get(id); t.assignee = assignee;
  }
}
