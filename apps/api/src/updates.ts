import { resolve, type UpdateStatus } from '@asf/shared';
import { cfg } from './settings.js';
import { registry } from './registry/client.js';

type Log = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
export type SemVer = { major: number; minor: number; patch: number };

/**
 * Update check (ADHOC-07222A46 part 1): does a newer ASF release exist?
 *
 * The running version is baked into each image as ASF_BUILD_VERSION (`git describe
 * --tags`: `v0.1.0` on a tag, `v0.1.0-5-gabc123` on main, `dev` outside CI). The
 * latest release is the highest strict `vX.Y.Z` tag of UPDATE_IMAGE_REPO, read
 * anonymously from the registry's v2 API. The last result lives in memory; nothing
 * is installed by the check; applying one is applyUpdate() below (part 2).
 */

const DAY_MS = 86_400_000;
const TICK_MS = 3_600_000;
const TIMEOUT_MS = 15_000;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-\d+-g[0-9a-f]+)?$/;

/** `v1.2.3`, `1.2.3` or a describe build `v1.2.3-N-gsha` (counts as 1.2.3); anything else (`dev`) is null. */
export function parseVersion(s: string): SemVer | null {
  const m = VERSION.exec(s.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function currentVersion(): string {
  return process.env.ASF_BUILD_VERSION || 'dev';
}

async function getOk(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return res;
}

function nextLink(link: string | null): string | null {
  const m = link && /<([^>]+)>\s*;\s*rel="?next"?/.exec(link);
  return m ? m[1] : null;
}

/** The highest strict vX.Y.Z tag of `repo` (`host/name`), or null when there is none. Throws on HTTP/network errors. */
export async function latestRelease(repo: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const slash = repo.indexOf('/');
  if (slash < 1) throw new Error(`UPDATE_IMAGE_REPO must be host/name, got "${repo}"`);
  const host = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const base = `https://${host}`;

  const tokenRes = await getOk(fetchImpl, `${base}/token?scope=repository:${name}:pull`);
  const { token } = await tokenRes.json() as { token?: string };
  if (!token) throw new Error('the registry returned no pull token');

  let best: { tag: string; v: SemVer } | null = null;
  let url: string | null = `${base}/v2/${name}/tags/list`;
  for (let page = 0; url && page < 100; page++) {
    const res = await getOk(fetchImpl, url, { authorization: `Bearer ${token}` });
    const { tags } = await res.json() as { tags?: string[] | null };
    for (const tag of tags ?? []) {
      if (!RELEASE_TAG.test(tag)) continue;
      const v = parseVersion(tag)!;
      if (!best || compareSemver(v, best.v) > 0) best = { tag, v };
    }
    const next = nextLink(res.headers.get('link'));
    url = next ? new URL(next, base).toString() : null;
  }
  return best?.tag ?? null;
}

let status: UpdateStatus = { current: currentVersion(), latest: null, available: false, checkedAt: null, error: null, canApply: false };
let inflight: Promise<UpdateStatus> | null = null;

/**
 * Whether the UI may offer "apply": a supervisor to run the updater, and a newer
 * release. Busy workers are not considered here (they change minute to minute);
 * applyUpdate() re-checks and refuses with a reason.
 */
function canApply(s: UpdateStatus): boolean {
  return resolve('ASF_LOCAL_SUPERVISOR') && s.available && !!s.latest;
}

export function updateStatus(): UpdateStatus {
  return { ...status, current: currentVersion(), canApply: canApply(status) };
}

/** Check now. Never throws: a failure is recorded in `error` (and `checkedAt` still moves). */
export function checkNow(fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  inflight ??= (async () => {
    const current = currentVersion();
    try {
      const latest = await latestRelease(cfg('UPDATE_IMAGE_REPO'), fetchImpl);
      const cur = parseVersion(current);
      const lat = latest ? parseVersion(latest) : null;
      const available = !!(cur && lat && compareSemver(lat, cur) > 0);
      status = { current, latest, available, checkedAt: new Date().toISOString(), error: null, canApply: false };
    } catch (e) {
      status = { ...status, current, checkedAt: new Date().toISOString(), error: (e as Error).message, canApply: false };
    }
    return updateStatus();
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * A check at boot, then an hourly tick that checks when UPDATE_CHECK_ENABLED is on
 * and the last check is a day old — so turning the setting on in the UI takes
 * effect without a restart.
 */
export function startUpdateChecks(log: Log, fetchImpl: typeof fetch = fetch): () => void {
  const run = async () => {
    const s = await checkNow(fetchImpl);
    if (s.error) log.error({ err: s.error }, 'update check failed');
    else if (s.available) log.info({ current: s.current, latest: s.latest }, 'update available');
  };
  const due = () => {
    if (!cfg('UPDATE_CHECK_ENABLED')) return false;
    return !status.checkedAt || Date.now() - Date.parse(status.checkedAt) >= DAY_MS;
  };
  if (due()) void run();
  const timer = setInterval(() => { if (due()) void run(); }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export class UpdateRefused extends Error {}

/** The supervisor answers after it has pulled docker:cli (up to ~5 minutes) and started the updater. */
const APPLY_TIMEOUT_MS = 6 * 60_000;

/**
 * Apply the latest release (ADHOC-9B0D5947 part 2): ask the supervisor sidecar to
 * start its updater for `latest`. Refused (UpdateRefused, with a reason) without a
 * supervisor, without a newer release, while a worker has a task running or the
 * registry cannot say, or when the supervisor itself refuses. Any other supervisor
 * failure throws a plain Error.
 */
export async function applyUpdate(): Promise<{ version: string }> {
  if (!resolve('ASF_LOCAL_SUPERVISOR')) throw new UpdateRefused('no local supervisor in this deployment; run scripts/asf update on the host');
  const { available, latest } = status;
  if (!available || !latest) throw new UpdateRefused('no newer release is known; check for updates first');
  const fleet = await registry.listFleet().catch(() => null);
  if (!fleet) throw new UpdateRefused('the registry cannot be reached to confirm no task is running');
  if (fleet.running > 0) throw new UpdateRefused(`${fleet.running} task(s) are running; apply the update once they finish`);

  let res: Response;
  try {
    res = await fetch(`${resolve('SUPERVISOR_URL').replace(/\/$/, '')}/update`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: latest }),
      signal: AbortSignal.timeout(APPLY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`supervisor unreachable: ${(e as Error).message}`);
  }
  const body = await res.json().catch(() => null) as { reason?: string } | null;
  if (res.status === 409) throw new UpdateRefused(body?.reason ?? 'the supervisor refused');
  if (!res.ok) throw new Error(body?.reason ?? `supervisor answered ${res.status}`);
  return { version: latest };
}

/** Test hook. */
export function __resetUpdates(): void {
  status = { current: currentVersion(), latest: null, available: false, checkedAt: null, error: null, canApply: false };
  inflight = null;
}
