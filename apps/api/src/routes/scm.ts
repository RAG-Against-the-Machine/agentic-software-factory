import type { FastifyInstance } from 'fastify';
import type { ScmProvider, TicketProvider } from '@asf/shared';
import { config } from '../config.js';
import { registry } from '../registry/client.js';
import { cfg } from '../settings.js';
import { transitionTicketTo, parsePreferredStatuses } from '../tickets/transition.js';
import { ticketsFor } from '../tickets/route.js';

/**
 * The publish surface. The worker pushes the branch itself (it holds the clone
 * credential), then calls these to open and merge the change request through
 * the ScmProvider — the SCM credential lives here, never on the worker's agent.
 *
 * These are also the two points where the ticket moves along its board: the
 * change request opening is "in review", the merge is "done". The ticket id is
 * read from the run (it carries ticketId), so a Jira ticket driving a GitHub
 * PR is transitioned on the Jira side here. Best-effort — a status move never
 * fails the publish (see transitionTicketTo).
 */
export function registerScmRoutes(app: FastifyInstance, deps: { scm: ScmProvider; tickets: TicketProvider }): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/scm/')) return;
    if (req.headers['x-run-secret'] !== config.runEventSecret) reply.code(401).send({ error: 'unauthorized' });
  });

  // Open a draft change request for a run's branch, and write the body from its artifacts.
  app.post<{ Body: { runId: string; head: string; base: string; title: string; body: string; draft: boolean } }>(
    '/api/scm/change-request', async (req, reply) => {
      const { runId, head, base, title, body, draft } = req.body;
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = await deps.scm.getRepo(got.run.repoId);
      const cr = await deps.scm.openChangeRequest(repo, { head, base, title, body, draft });
      // The PR is open → move the ticket into review.
      await transitionTicketTo(ticketsFor(deps.tickets, got.run.ticketId), got.run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_INREVIEW')));
      return { changeRequest: cr };
    });

  app.post<{ Body: { runId: string; number: number; method: 'merge' | 'squash' | 'rebase' } }>(
    '/api/scm/merge', async (req, reply) => {
      const { runId, number, method } = req.body;
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = await deps.scm.getRepo(got.run.repoId);
      await deps.scm.markReady(repo, number).catch(() => {});
      await deps.scm.merge(repo, number, { method });
      // Merged → the work is done; close the ticket out.
      await transitionTicketTo(ticketsFor(deps.tickets, got.run.ticketId), got.run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_DONE')));
      return { ok: true };
    });

  // Merge OFF path: mark the draft CR ready for review (ASF does not merge). The
  // ticket moves to "in review" — a human reviews + merges in the SCM.
  app.post<{ Body: { runId: string; number: number } }>(
    '/api/scm/mark-ready', async (req, reply) => {
      const { runId, number } = req.body;
      const got = await registry.getRun(runId);
      if (!got?.run.repoId) return reply.code(400).send({ error: 'no_repo' });
      const repo = await deps.scm.getRepo(got.run.repoId);
      await deps.scm.markReady(repo, number);
      await transitionTicketTo(ticketsFor(deps.tickets, got.run.ticketId), got.run.ticketId, parsePreferredStatuses(cfg('TICKET_STATUS_INREVIEW')));
      return { ok: true };
    });
}
