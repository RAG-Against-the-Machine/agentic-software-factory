import type { FastifyInstance } from 'fastify';

/**
 * Machine gate: may this process talk to the registry at all? Every route
 * except /health requires X-Run-Secret. Human identity (who pressed the
 * button) is a separate question carried in request bodies as `by`, and is
 * not authenticated in the single-operator MVP.
 */
export function installAuth(app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.url.startsWith('/health?')) return;
    const got = req.headers['x-run-secret'];
    if (got !== secret) {
      reply.code(401).send({ error: 'unauthorized', reason: 'missing or wrong X-Run-Secret' });
    }
  });
}
