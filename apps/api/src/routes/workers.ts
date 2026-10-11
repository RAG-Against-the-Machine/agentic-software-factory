import type { FastifyInstance } from 'fastify';
import { resolve, supervisorStatusSchema, type LocalWorkerStatus } from '@asf/shared';
import { resolveIdentity } from '../identity.js';

/**
 * The local worker (#135): when the self-host stack runs the supervisor sidecar
 * (ASF_LOCAL_SUPERVISOR), /setup and /workers can see why no worker is online and
 * start the stopped compose worker. Same trust model as /api/fleet — the api's
 * bind (or the AUTH_MODE=header proxy) is the gate; who pressed Start is logged.
 *
 * Anything short of a well-formed supervisor answer is `available:false`, which
 * the UI turns into the `./scripts/asf up` hint rather than an error.
 */
const TIMEOUT_MS = 5_000;

function enabled(): boolean { return resolve('ASF_LOCAL_SUPERVISOR'); }
const OFF = { available: false as const, reason: 'no local supervisor in this deployment' };

async function callSupervisor(method: 'GET' | 'POST', path: string): Promise<LocalWorkerStatus & { status?: number }> {
  let res: Response;
  try {
    res = await fetch(`${resolve('SUPERVISOR_URL').replace(/\/$/, '')}${path}`, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { available: false, reason: `supervisor unreachable: ${(e as Error).message}` };
  }
  const body = await res.json().catch(() => null) as { reason?: string } | null;
  if (!res.ok) return { available: false, reason: body?.reason ?? `supervisor answered ${res.status}`, status: res.status };
  const parsed = supervisorStatusSchema.safeParse(body);
  if (!parsed.success) return { available: false, reason: 'supervisor sent an unexpected answer' };
  return { available: true, ...parsed.data };
}

export function registerWorkerRoutes(app: FastifyInstance): void {
  app.get('/api/workers/local', async (): Promise<LocalWorkerStatus> => {
    if (!enabled()) return OFF;
    const s = await callSupervisor('GET', '/status');
    delete s.status;
    return s;
  });

  app.post('/api/workers/local/start', async (req, reply) => {
    if (!enabled()) return reply.code(409).send({ error: 'unavailable', reason: OFF.reason });
    req.log.info({ by: resolveIdentity(req).user }, 'local worker start requested');
    const { status, ...s } = await callSupervisor('POST', '/start');
    if (!s.available) return reply.code(status === 409 ? 409 : 502).send({ error: 'start_failed', reason: s.reason });
    return s;
  });
}
