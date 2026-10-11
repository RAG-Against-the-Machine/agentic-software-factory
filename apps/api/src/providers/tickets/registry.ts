import type {
  Preflight, Ticket, TicketComment, TicketLink, TicketListQuery,
  TicketProvider, TicketProviderCapabilities, TicketProviderKind, TicketScope,
  TicketSprint, TicketTransition,
} from '@asf/shared';

/**
 * Hot-swappable ticket-provider resolution (white-label WP A).
 *
 * The api used to build ONE TicketProvider at boot from TICKET_PROVIDER and
 * inject that fixed instance into every route. That makes the provider a
 * deploy-time choice: changing it needs an env edit + restart. For a white-label
 * product the operator picks the provider (and enters its config) in the UI and
 * expects it to take effect live.
 *
 * This registry decouples "which provider" from "when it was chosen":
 *
 *  - `build(kind)` constructs a provider from the CURRENT resolved config. It is
 *    async because a UI-entered credential may be a `secret://org/...` pointer
 *    that has to be fetched at build time (WP B/C).
 *  - `current()` returns the cached instance, rebuilding once whenever the config
 *    changed since the last build (an `invalidate()` sets a dirty flag; the admin
 *    route calls it after any settings write). Concurrent callers during a
 *    rebuild share a single in-flight build promise so we never construct twice
 *    or tear down an instance another request is mid-call on.
 *  - `live` is a stable proxy implementing TicketProvider whose every method
 *    forwards to `current()`. Routes and the scheduler are injected this proxy
 *    and never learn that the underlying instance can change — no call site reads
 *    a cached `.kind` or holds a stale reference.
 *
 * `kind` is always read off the built instance, never cached independently.
 */
export class TicketProviderRegistry {
  private instance: TicketProvider | null = null;
  private dirty = true;
  private building: Promise<TicketProvider> | null = null;

  /**
   * A stable TicketProvider that always forwards to the current instance, so it
   * can be injected once and survive every hot-swap. `kind` is a getter that
   * reflects the instance last resolved by `current()`; every method awaits
   * `current()` so it operates on the live instance (rebuilding if dirty).
   */
  readonly live: TicketProvider;

  constructor(private readonly build: (kind: string) => Promise<TicketProvider>, private readonly kindOf: () => string) {
    const live: Omit<TicketProvider, 'kind'> = {
      preflight: (): Promise<Preflight> => this.current().then((p) => p.preflight()),
      capabilities: (): TicketProviderCapabilities =>
        // capabilities() is sync on the interface; report the current instance's
        // (or a conservative all-false default before the first build).
        this.instance?.capabilities() ?? { subtasks: false, priority: false, links: false, transitions: false, assignable: false, boards: false, sprints: false, statuses: false },
      list: (q: TicketListQuery) => this.current().then((p) => p.list(q)),
      get: (id: string) => this.current().then((p) => p.get(id)),
      update: (id: string, patch: Partial<Pick<Ticket, 'title' | 'body' | 'priority' | 'labels'>>) => this.current().then((p) => p.update(id, patch)),
      createSubtask: (parentId: string, input: { title: string; body?: string }) => this.current().then((p) => p.createSubtask(parentId, input)),
      addLink: (id: string, link: TicketLink) => this.current().then((p) => p.addLink(id, link)),
      comment: (id: string, markdown: string) => this.current().then((p) => p.comment(id, markdown)),
      listComments: (id: string): Promise<TicketComment[]> => this.current().then((p) => p.listComments(id)),
      transitions: (id: string): Promise<TicketTransition[]> => this.current().then((p) => p.transitions(id)),
      transition: (id: string, transitionId: string) => this.current().then((p) => p.transition(id, transitionId)),
      assign: (id: string, assignee: string | null) => this.current().then((p) => p.assign(id, assignee)),
      listScopes: (): Promise<TicketScope[]> => this.current().then((p) => p.listScopes()),
      listSprints: (scopeId: string): Promise<TicketSprint[]> => this.current().then((p) => p.listSprints(scopeId)),
      listStatuses: (scopeId?: string): Promise<string[]> => this.current().then((p) => p.listStatuses(scopeId)),
      suggestedRepo: (ticket: Ticket) => this.instance?.suggestedRepo?.(ticket) ?? null,
    };
    // `kind` stays a live getter (it follows hot-swaps); an arrow keeps `this` = the registry.
    Object.defineProperty(live, 'kind', { get: () => (this.instance?.kind ?? 'mock') as TicketProviderKind, enumerable: true });
    this.live = live as TicketProvider;
  }

  /** Mark the current instance stale; the next `current()` rebuilds. Cheap; safe to call often. */
  invalidate(): void {
    this.dirty = true;
  }

  /** The live provider, rebuilding at most once per config change. Concurrent callers share one build. */
  async current(): Promise<TicketProvider> {
    if (this.instance && !this.dirty) return this.instance;
    if (this.building) return this.building;
    // Snapshot dirty->clean BEFORE awaiting so an invalidate() that arrives
    // mid-build re-dirties us and forces another rebuild afterwards.
    this.dirty = false;
    this.building = this.build(this.kindOf())
      .then((p) => { this.instance = p; return p; })
      .catch((e) => { this.dirty = true; throw e; })
      .finally(() => { this.building = null; });
    return this.building;
  }
}
