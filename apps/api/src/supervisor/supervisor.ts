import http from 'node:http';
import os from 'node:os';
import type { LocalWorkerState, SupervisorStatus } from '@asf/shared';

/**
 * The supervisor sidecar (#135): the one process in the self-host stack that holds
 * the Docker socket. Its scope is two jobs: start the compose worker, so a user of
 * /setup or /workers needs no terminal, and run the updater (ADHOC-9B0D5947), so
 * an operator can apply a release from the UI. Deliberately tiny and narrow:
 *
 *   GET  /status   the worker container's state (running|restarting|exited|missing)
 *   POST /start    start an exited worker, or restart one stuck restarting
 *   GET  /update   {running, version} of the updater container
 *   POST /update   {version: 'vX.Y.Z'} — start the updater for that release
 *
 * /start only ever acts on THE container labelled as the asf project's `worker`
 * service — no container id or name is accepted from the caller. /update creates
 * one throwaway `docker:cli` container whose command is fixed here (pin
 * ASF_VERSION in .env, then `docker compose pull && up -d` for the project this
 * supervisor belongs to); the caller supplies only a strict version string. No
 * other Docker operation (stop, logs, exec, …) exists here. It holds no
 * credentials (compose gives it no env_file) and publishes no port.
 *
 * Docker Engine API over the unix socket with node `http`; no dependencies.
 */

export const COMPOSE_PROJECT = 'asf';
export const WORKER_SERVICE = 'worker';
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';

interface DockerResponse { status: number; body: unknown }

function docker(socketPath: string, method: 'GET' | 'POST', path: string, opts: { body?: unknown; timeoutMs?: number } = {}): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: 'docker' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ socketPath, method, path, headers, timeout: opts.timeoutMs ?? 10_000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('docker: request timed out')));
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

function dockerError(what: string, r: DockerResponse): Error {
  const msg = (r.body as { message?: string } | null)?.message ?? String(r.body ?? '');
  return new Error(`docker ${what}: ${r.status} ${msg}`.trim());
}

interface ContainerSummary { Id: string; Labels?: Record<string, string> }
interface ContainerInspect { State?: { Status?: string; Restarting?: boolean; ExitCode?: number }; RestartCount?: number }

/** The asf worker container's id, or null. Labels are re-checked here, not just trusted to the filter. */
async function findWorker(socketPath: string): Promise<string | null> {
  const filters = JSON.stringify({ label: [`${PROJECT_LABEL}=${COMPOSE_PROJECT}`, `${SERVICE_LABEL}=${WORKER_SERVICE}`] });
  const r = await docker(socketPath, 'GET', `/containers/json?all=1&filters=${encodeURIComponent(filters)}`);
  if (r.status !== 200 || !Array.isArray(r.body)) throw dockerError('list containers', r);
  const match = (r.body as ContainerSummary[]).find((c) =>
    c.Labels?.[PROJECT_LABEL] === COMPOSE_PROJECT && c.Labels?.[SERVICE_LABEL] === WORKER_SERVICE);
  return match?.Id ?? null;
}

function toState(s: ContainerInspect['State']): LocalWorkerState {
  if (s?.Restarting || s?.Status === 'restarting') return 'restarting';
  if (s?.Status === 'running' || s?.Status === 'paused') return 'running';
  return 'exited'; // created | exited | dead — all "not running, start it"
}

async function inspect(socketPath: string, id: string): Promise<SupervisorStatus> {
  const r = await docker(socketPath, 'GET', `/containers/${encodeURIComponent(id)}/json`);
  if (r.status === 404) return { state: 'missing', exitCode: null, restartCount: null };
  if (r.status !== 200) throw dockerError('inspect worker', r);
  const c = r.body as ContainerInspect;
  return { state: toState(c.State), exitCode: c.State?.ExitCode ?? null, restartCount: c.RestartCount ?? null };
}

export async function workerStatus(socketPath: string): Promise<SupervisorStatus> {
  const id = await findWorker(socketPath);
  return id ? inspect(socketPath, id) : { state: 'missing', exitCode: null, restartCount: null };
}

/**
 * Start an exited worker or restart a restarting one; a running worker is left
 * alone. A missing worker is refused: the supervisor never creates containers.
 */
export async function startWorker(socketPath: string): Promise<SupervisorStatus> {
  const id = await findWorker(socketPath);
  if (!id) throw new RefusedError('no asf worker container exists; run ./scripts/asf up');
  const before = await inspect(socketPath, id);
  if (before.state === 'running' || before.state === 'missing') return before;
  const op = before.state === 'exited' ? 'start' : 'restart';
  const r = await docker(socketPath, 'POST', `/containers/${encodeURIComponent(id)}/${op}`);
  // 304 = already started (raced with Docker's own restart policy) — fine.
  if (r.status !== 204 && r.status !== 304) throw dockerError(`${op} worker`, r);
  return inspect(socketPath, id);
}

export class RefusedError extends Error {}

// --- the updater (ADHOC-9B0D5947) ---

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const UPDATER_LABEL = 'asf.updater';
const UPDATER_VERSION_LABEL = 'asf.updater.version';
const UPDATER_IMAGE = 'docker:cli';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
const DOCKER_SOCKET = '/var/run/docker.sock';
const PULL_TIMEOUT_MS = 5 * 60_000;

export interface UpdaterStatus { running: boolean; version: string | null }

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The updater's shell script. Pure; every path is single-quoted. It pins
 * ASF_VERSION in .env (replacing the line, or appending one) and writes it back
 * with `cat >` so .env keeps its owner and mode, then pulls and recreates the project.
 */
export function updaterScript(version: string, dir: string, files: string[]): string {
  const compose = ['docker compose -p', COMPOSE_PROJECT, '--project-directory', sq(dir), ...files.map((f) => `-f ${sq(f)}`)].join(' ');
  return [
    'set -e',
    `cd ${sq(dir)}`,
    `awk -v v=${sq(version)} '/^ASF_VERSION=/ { print "ASF_VERSION=" v; d = 1; next } { print } END { if (!d) print "ASF_VERSION=" v }' .env > /tmp/asf.env`,
    'cat /tmp/asf.env > .env',
    `${compose} pull && ${compose} up -d`,
  ].join('\n');
}

/** Running updater containers. The label is re-checked here, not just trusted to the filter. */
async function findUpdaters(socketPath: string): Promise<ContainerSummary[]> {
  const filters = JSON.stringify({ label: [`${UPDATER_LABEL}=1`] });
  const r = await docker(socketPath, 'GET', `/containers/json?filters=${encodeURIComponent(filters)}`);
  if (r.status !== 200 || !Array.isArray(r.body)) throw dockerError('list containers', r);
  return (r.body as ContainerSummary[]).filter((c) => c.Labels?.[UPDATER_LABEL] === '1');
}

export async function updaterStatus(socketPath: string): Promise<UpdaterStatus> {
  const [u] = await findUpdaters(socketPath);
  return { running: !!u, version: u?.Labels?.[UPDATER_VERSION_LABEL] ?? null };
}

/**
 * Start the updater for `version`. Refused for anything but a strict vX.Y.Z, while
 * another updater runs, or when this supervisor's own container lacks the compose
 * labels saying where the project lives.
 */
export async function startUpdater(socketPath: string, selfId: string, version: unknown): Promise<UpdaterStatus> {
  if (typeof version !== 'string' || !RELEASE_TAG.test(version)) throw new RefusedError('version must be a release tag like v1.2.3');
  if ((await findUpdaters(socketPath)).length) throw new RefusedError('an update is already running');

  const self = await docker(socketPath, 'GET', `/containers/${encodeURIComponent(selfId)}/json`);
  if (self.status !== 200) throw dockerError('inspect supervisor', self);
  const labels = (self.body as { Config?: { Labels?: Record<string, string> } } | null)?.Config?.Labels ?? {};
  const dir = labels[WORKING_DIR_LABEL];
  const files = (labels[CONFIG_FILES_LABEL] ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  if (!dir || !files.length) throw new RefusedError('the supervisor container has no compose project labels; run scripts/asf update on the host');

  // The pull streams progress as JSON lines; a failure can still arrive with a 200.
  const pull = await docker(socketPath, 'POST', `/images/create?fromImage=${encodeURIComponent(UPDATER_IMAGE)}`, { timeoutMs: PULL_TIMEOUT_MS });
  const pullText = typeof pull.body === 'string' ? pull.body : JSON.stringify(pull.body);
  if (pull.status !== 200 || /"error"\s*:/.test(pullText)) throw dockerError(`pull ${UPDATER_IMAGE}`, pull);

  const created = await docker(socketPath, 'POST', '/containers/create', { body: {
    Image: UPDATER_IMAGE,
    Cmd: ['sh', '-c', updaterScript(version, dir, files)],
    WorkingDir: dir,
    Labels: { [UPDATER_LABEL]: '1', [UPDATER_VERSION_LABEL]: version },
    HostConfig: { Binds: [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`, `${dir}:${dir}`], AutoRemove: true },
  } });
  const id = (created.body as { Id?: string } | null)?.Id;
  if (created.status !== 201 || !id) throw dockerError('create updater', created);
  const started = await docker(socketPath, 'POST', `/containers/${encodeURIComponent(id)}/start`);
  if (started.status !== 204 && started.status !== 304) throw dockerError('start updater', started);
  return { running: true, version };
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

/**
 * The sidecar's HTTP server. Exactly four routes; everything else is 404.
 * `selfId` is this supervisor's own container (its hostname inside Docker).
 */
export function createSupervisorServer(opts: { socketPath: string; selfId?: string; log?: (msg: string) => void }): http.Server {
  const log = opts.log ?? (() => {});
  const selfId = opts.selfId ?? os.hostname();
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/status') return send(200, await workerStatus(opts.socketPath));
      if (req.method === 'POST' && path === '/start') {
        const s = await startWorker(opts.socketPath);
        log(`start requested; worker is ${s.state}`);
        return send(200, s);
      }
      if (req.method === 'GET' && path === '/update') return send(200, await updaterStatus(opts.socketPath));
      if (req.method === 'POST' && path === '/update') {
        const body = await readJson(req) as { version?: unknown } | null;
        const s = await startUpdater(opts.socketPath, selfId, body?.version);
        log(`update to ${s.version} started`);
        return send(200, s);
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof RefusedError) return send(409, { error: 'refused', reason: e.message });
      log(`docker error: ${(e as Error).message}`);
      return send(502, { error: 'docker_error', reason: (e as Error).message });
    }
  });
}
