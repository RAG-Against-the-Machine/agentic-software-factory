import type { Repo, ScmProvider, Ticket, TicketProvider } from '@asf/shared';

/**
 * Can work start at all, and in which repository?
 *
 * A run with no repository has nowhere to put code: the planner reads an empty
 * directory and asks "where is the repo?", and a writing role fails outright
 * (segment.ts). So a ticket source on its own is not enough. Nothing may start
 * (hand dispatch, the queue, the scheduler) until source control is connected
 * and at least one repository is reachable, and each run is bound to exactly
 * one repository at dispatch. Refuse with a plain reason and a link to the
 * panel that fixes it, rather than create a run that can't do anything.
 */

/** Where the operator fixes a missing repository. */
export const CODE_SETTINGS_LINK = '/settings#code';

export type RepoBlocker = 'scm_not_connected' | 'no_repos' | 'repo_not_found' | 'repo_ambiguous';

export type Readiness =
  | { ok: true; repos: Repo[] }
  | { ok: false; code: RepoBlocker; reason: string; link: string };

/** Source control is connected and names at least one reachable repository. */
export async function startReadiness(scm: ScmProvider): Promise<Readiness> {
  const pf = await scm.preflight().catch((e: Error) => ({ ok: false as const, reason: e.message }));
  if (!pf.ok) {
    return { ok: false, code: 'scm_not_connected', link: CODE_SETTINGS_LINK,
      reason: `Connect the repository the work goes into before starting anything. ${(pf.reason ?? 'The connection check failed.').replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, '$1.')}` };
  }
  const repos = await scm.searchRepos('').catch(() => [] as Repo[]);
  if (repos.length === 0) {
    return { ok: false, code: 'no_repos', link: CODE_SETTINGS_LINK,
      reason: 'Source control is connected but no repository is chosen. Add the repository the work goes into (Settings → Where does your code live?) before starting anything.' };
  }
  return { ok: true, repos };
}

/**
 * The one repository a run works in: the one asked for, else the ticket's own
 * (a GitHub issue lives in a repo), else the only one there is. With several and
 * no way to tell, refuse instead of guessing which codebase to change.
 */
export async function pickRepo(
  deps: { tickets: TicketProvider; scm: ScmProvider }, ticket: Ticket, repos: Repo[], requested?: string | null,
): Promise<{ ok: true; repo: Repo } | { ok: false; code: RepoBlocker; reason: string; link: string }> {
  const find = async (idOrPath: string): Promise<Repo | null> =>
    repos.find((r) => r.id === idOrPath || r.path === idOrPath) ?? await deps.scm.getRepo(idOrPath).catch(() => null);

  if (requested) {
    const repo = await find(requested);
    return repo ? { ok: true, repo }
      : { ok: false, code: 'repo_not_found', link: CODE_SETTINGS_LINK, reason: `The repository "${requested}" isn't one source control can reach. Pick one of: ${repos.map((r) => r.path).join(', ')}.` };
  }
  const suggested = deps.tickets.suggestedRepo?.(ticket) ?? null;
  if (suggested) {
    const repo = await find(suggested);
    if (repo) return { ok: true, repo };
  }
  if (repos.length === 1) return { ok: true, repo: repos[0] };
  return { ok: false, code: 'repo_ambiguous', link: CODE_SETTINGS_LINK,
    reason: `Choose which repository ${ticket.key} should change (${repos.map((r) => r.path).join(', ')}).` };
}
