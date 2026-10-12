import type { FastifyInstance } from 'fastify';
import { isGcpProjectId, isVertexRegion, vertexCheckRequestSchema, vertexCheckResultSchema } from '@asf/shared';
import { config } from '../config.js';
import { vertexChecks as defaultChecks, type VertexChecks } from '../vertex-checks.js';

/**
 * "Check which Claude models work" for Claude on Google Cloud (M9).
 *
 *   POST /api/providers/vertex/check      (browser) queue a check -> { id }
 *   GET  /api/providers/vertex/check/:id  (browser) its state / result
 *   POST /api/agent-checks/vertex/next    (worker)  take the oldest queued check
 *   POST /api/agent-checks/vertex/:id     (worker)  post its result
 *
 * The worker paths carry X-Run-Secret, like /api/agent-auth.
 */
export function registerVertexRoutes(app: FastifyInstance, checks: VertexChecks = defaultChecks): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/agent-checks/')) return;
    if (req.headers['x-run-secret'] !== config.runEventSecret) {
      reply.code(401).send({ error: 'unauthorized', reason: 'missing or wrong X-Run-Secret' });
    }
  });

  app.post('/api/providers/vertex/check', async (req, reply) => {
    const parsed = vertexCheckRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', reason: 'Send a project id, a region and at least one model id.' });
    const { projectId, region } = parsed.data;
    if (!isGcpProjectId(projectId.trim())) {
      return reply.code(400).send({ error: 'bad_project', reason: `“${projectId}” isn’t a Google Cloud project id. It’s lowercase letters, digits and hyphens, like my-team-ai (not the project’s display name or number).` });
    }
    if (!isVertexRegion(region.trim())) {
      return reply.code(400).send({ error: 'bad_region', reason: `“${region}” isn’t a Vertex AI region. Use global, or a region such as us-east5.` });
    }
    const models = [...new Set(parsed.data.models.map((m) => m.trim()).filter(Boolean))];
    return { id: checks.create({ projectId: projectId.trim(), region: region.trim(), models }) };
  });

  app.get<{ Params: { id: string } }>('/api/providers/vertex/check/:id', async (req, reply) => {
    const s = checks.get(req.params.id);
    return s ?? reply.code(404).send({ error: 'not_found', reason: 'That check has expired. Check again.' });
  });

  app.post<{ Body: { worker?: string } }>('/api/agent-checks/vertex/next', async (req) => {
    const worker = String(req.body?.worker ?? '').trim() || 'unknown';
    return { check: checks.take(worker) };
  });

  app.post<{ Params: { id: string }; Body: { worker?: string; result?: unknown } }>('/api/agent-checks/vertex/:id', async (req, reply) => {
    const parsed = vertexCheckResultSchema.safeParse(req.body?.result);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', reason: parsed.error.message });
    const ok = checks.finish(req.params.id, String(req.body?.worker ?? 'unknown'), parsed.data);
    return ok ? { ok: true } : reply.code(409).send({ error: 'not_running', reason: 'check unknown or already finished' });
  });
}
