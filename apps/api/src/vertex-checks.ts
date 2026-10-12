import { randomUUID } from 'node:crypto';
import type { VertexCheckRequest, VertexCheckResult, VertexCheckState } from '@asf/shared';

/**
 * The Vertex check's hand-off between the UI and a worker (M9).
 *
 * Only a worker holds the Google login (the host's Application Default
 * Credentials, mounted into it), so the api cannot test Vertex itself. The UI
 * queues a check here; the first worker that polls takes it, runs it and posts
 * the result; the UI polls until it is done. In memory: a check lives for a few
 * minutes, and the self-hosted api is one process. (A multi-instance hosted api
 * would need this in the registry; there the operator sets Vertex in env anyway.)
 */
interface Job {
  id: string;
  request: VertexCheckRequest;
  state: 'queued' | 'running' | 'done';
  worker?: string;
  createdAt: number;
  startedAt?: number;
  result?: VertexCheckResult;
}

/** No worker took the check in this long: say so instead of spinning forever. */
export const QUEUE_TIMEOUT_MS = 90_000;
/** A worker took it but never answered (crashed, restarted). */
export const RUN_TIMEOUT_MS = 5 * 60_000;
/** A finished check is kept this long for the UI to read. */
const KEEP_MS = 15 * 60_000;

export class VertexChecks {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly now: () => number = Date.now) {}

  create(request: VertexCheckRequest): string {
    this.sweep();
    const id = randomUUID();
    this.jobs.set(id, { id, request, state: 'queued', createdAt: this.now() });
    return id;
  }

  /** The oldest queued check, now marked as running on `worker`; null when none waits. */
  take(worker: string): { id: string; request: VertexCheckRequest } | null {
    this.sweep();
    const job = [...this.jobs.values()].filter((j) => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    job.state = 'running'; job.worker = worker; job.startedAt = this.now();
    return { id: job.id, request: job.request };
  }

  /** Record a worker's result. False when the check is unknown or already finished. */
  finish(id: string, worker: string, result: VertexCheckResult): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state === 'done') return false;
    job.state = 'done'; job.result = { ...result, worker };
    return true;
  }

  get(id: string): VertexCheckState | null {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state === 'done') return { id, state: 'done', result: job.result! };
    return { id, state: job.state, ...(job.worker ? { worker: job.worker } : {}), since: new Date(job.startedAt ?? job.createdAt).toISOString() };
  }

  private sweep(): void {
    const t = this.now();
    for (const job of this.jobs.values()) {
      if (job.state === 'queued' && t - job.createdAt > QUEUE_TIMEOUT_MS) {
        job.state = 'done';
        job.result = failed('no_worker', 'No worker picked up the check. The check runs on a worker, because only the worker has your Google login. Make sure the factory is running (see Workers), then check again.', t);
      } else if (job.state === 'running' && t - (job.startedAt ?? t) > RUN_TIMEOUT_MS) {
        job.state = 'done';
        job.result = failed('other', `Worker ${job.worker} started the check but never finished it (it may have restarted). Check again.`, t);
      } else if (job.state === 'done' && t - job.createdAt > KEEP_MS) {
        this.jobs.delete(job.id);
      }
    }
  }
}

function failed(code: 'no_worker' | 'other', reason: string, t: number): VertexCheckResult {
  return { ok: false, login: { ok: false, code, reason }, models: [], claudeCode: { ok: false, skipped: true }, checkedAt: new Date(t).toISOString() };
}

export const vertexChecks = new VertexChecks();
