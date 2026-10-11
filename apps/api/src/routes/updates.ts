import type { FastifyInstance } from 'fastify';
import type { UpdateStatus } from '@asf/shared';
import { applyUpdate, checkNow, updateStatus, UpdateRefused } from '../updates.js';
import { resolveIdentity } from '../identity.js';

/**
 * Updates (ADHOC-07222A46): the last check result, a check on demand, and applying
 * the latest release through the supervisor sidecar. Same trust model as
 * /api/workers/local/start — the api's bind is the gate; who asked is logged.
 */
export function registerUpdateRoutes(app: FastifyInstance): void {
  app.get('/api/updates', async (): Promise<UpdateStatus> => updateStatus());
  app.post('/api/updates/check', async (): Promise<UpdateStatus> => checkNow());
  app.post('/api/updates/apply', async (req, reply) => {
    const by = resolveIdentity(req).user;
    try {
      const { version } = await applyUpdate();
      req.log.info({ by, version }, 'update apply started');
      return { started: true, version };
    } catch (e) {
      const reason = (e as Error).message;
      req.log.info({ by, reason }, 'update apply refused or failed');
      if (e instanceof UpdateRefused) return reply.code(409).send({ error: 'refused', reason });
      return reply.code(502).send({ error: 'apply_failed', reason });
    }
  });
}
