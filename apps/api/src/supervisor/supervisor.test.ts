import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSupervisorServer, updaterScript } from './supervisor.js';

// A fake Docker Engine API on a temp unix socket. It returns EVERY container from
// /containers/json regardless of filters, so the supervisor's own label check is
// exercised too, and it records every request so "no other container touched" is checkable.
// It also pulls images (no-op) and creates containers, recording each create body.
interface FakeContainer { Id: string; Labels: Record<string, string>; State: { Status: string; Restarting: boolean; ExitCode: number }; RestartCount: number }
const compose = (project: string, service: string) => ({ 'com.docker.compose.project': project, 'com.docker.compose.service': service });

async function withFakeDocker(containers: FakeContainer[], fn: (base: string, calls: string[], created: Record<string, unknown>[]) => Promise<void>, opts: { failPull?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'asf-sup-'));
  const socketPath = join(dir, 'docker.sock');
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const dockerd = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? '/', 'http://docker');
    const json = (status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/containers/json') return json(200, containers.map((c) => ({ Id: c.Id, Labels: c.Labels })));
    if (req.method === 'POST' && url.pathname === '/images/create') {
      res.writeHead(200);
      return res.end(opts.failPull ? '{"status":"Pulling"}\n{"error":"no such image","errorDetail":{"message":"no such image"}}\n' : '{"status":"Pulling"}\n{"status":"Done"}\n');
    }
    if (req.method === 'POST' && url.pathname === '/containers/create') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw) as { Labels: Record<string, string> };
      created.push(body);
      containers.push({ Id: 'upd1', Labels: body.Labels, State: { Status: 'created', Restarting: false, ExitCode: 0 }, RestartCount: 0 });
      return json(201, { Id: 'upd1' });
    }
    const m = url.pathname.match(/^\/containers\/([^/]+)\/(json|start|restart)$/);
    const c = m && containers.find((x) => x.Id === decodeURIComponent(m[1]));
    if (!c) return json(404, { message: 'No such container' });
    if (req.method === 'GET' && m![2] === 'json') return json(200, { State: c.State, RestartCount: c.RestartCount, Config: { Labels: c.Labels } });
    if (req.method === 'POST') { c.State = { Status: 'running', Restarting: false, ExitCode: 0 }; return json(204); }
    return json(405, { message: 'nope' });
  });
  await new Promise<void>((r) => dockerd.listen(socketPath, r));
  const sup = createSupervisorServer({ socketPath, selfId: 'sup1' });
  await new Promise<void>((r) => sup.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(sup.address() as AddressInfo).port}`, calls, created);
  } finally {
    await new Promise((r) => sup.close(r));
    await new Promise((r) => dockerd.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

const worker = (Status: string, extra: Partial<FakeContainer['State']> = {}, restartCount = 0): FakeContainer =>
  ({ Id: 'w1', Labels: compose('asf', 'worker'), State: { Status, Restarting: false, ExitCode: 0, ...extra }, RestartCount: restartCount });
const others = (): FakeContainer[] => [
  { Id: 'api1', Labels: compose('asf', 'api'), State: { Status: 'exited', Restarting: false, ExitCode: 1 }, RestartCount: 0 },
  { Id: 'otherw', Labels: compose('other', 'worker'), State: { Status: 'exited', Restarting: false, ExitCode: 1 }, RestartCount: 0 },
];
const touched = (calls: string[]) => calls.filter((c) => c.startsWith('POST') || /\/containers\/[^/?]+\//.test(c));

test('status: running', async () => {
  await withFakeDocker([...others(), worker('running')], async (base) => {
    assert.deepEqual(await (await fetch(`${base}/status`)).json(), { state: 'running', exitCode: 0, restartCount: 0 });
  });
});

test('status: exited carries the exit code', async () => {
  await withFakeDocker([...others(), worker('exited', { ExitCode: 137 })], async (base) => {
    assert.deepEqual(await (await fetch(`${base}/status`)).json(), { state: 'exited', exitCode: 137, restartCount: 0 });
  });
});

test('status: restarting carries the restart count', async () => {
  await withFakeDocker([...others(), worker('restarting', { Restarting: true, ExitCode: 1 }, 7)], async (base) => {
    assert.deepEqual(await (await fetch(`${base}/status`)).json(), { state: 'restarting', exitCode: 1, restartCount: 7 });
  });
});

test('status: missing when only other containers exist (label check, not just the filter)', async () => {
  await withFakeDocker(others(), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/status`)).json(), { state: 'missing', exitCode: null, restartCount: null });
  });
});

test('start: an exited worker is started, and no other container is touched', async () => {
  await withFakeDocker([...others(), worker('exited', { ExitCode: 1 })], async (base, calls) => {
    const r = await fetch(`${base}/start`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { state: string }).state, 'running');
    assert.ok(calls.includes('POST /containers/w1/start'));
    assert.ok(touched(calls).every((c) => c.includes('/containers/w1/')), `touched: ${touched(calls).join(', ')}`);
  });
});

test('start: a restarting worker is restarted', async () => {
  await withFakeDocker([...others(), worker('restarting', { Restarting: true })], async (base, calls) => {
    assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 200);
    assert.ok(calls.includes('POST /containers/w1/restart'));
    assert.ok(touched(calls).every((c) => c.includes('/containers/w1/')));
  });
});

test('start: a running worker is left alone', async () => {
  await withFakeDocker([worker('running')], async (base, calls) => {
    assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 200);
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, 0);
  });
});

test('start: a missing worker is refused (never creates), nothing is touched', async () => {
  await withFakeDocker(others(), async (base, calls) => {
    const r = await fetch(`${base}/start`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(touched(calls).length, 0);
  });
});

test('only /status, /start and /update exist', async () => {
  await withFakeDocker([worker('exited')], async (base, calls) => {
    for (const [method, path] of [['POST', '/stop'], ['GET', '/start'], ['PUT', '/update'], ['POST', '/update/x'], ['POST', '/containers/api1/start'], ['GET', '/logs']] as const) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 404, `${method} ${path}`);
    }
    assert.equal(calls.length, 0);
  });
});

test('docker unreachable -> 502 with a reason', async () => {
  const sup = createSupervisorServer({ socketPath: join(tmpdir(), 'asf-no-such-docker.sock') });
  await new Promise<void>((r) => sup.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${(sup.address() as AddressInfo).port}/status`);
    assert.equal(r.status, 502);
    assert.equal(((await r.json()) as { error: string }).error, 'docker_error');
  } finally { await new Promise((r) => sup.close(r)); }
});

// --- the updater (ADHOC-9B0D5947) ---

const DIR = '/srv/asf';
const supervisor = (labels: Record<string, string> = {
  'com.docker.compose.project.working_dir': DIR,
  'com.docker.compose.project.config_files': `${DIR}/docker-compose.self-host.yml,${DIR}/docker-compose.host-worker.yml`,
}): FakeContainer => ({ Id: 'sup1', Labels: { ...compose('asf', 'supervisor'), ...labels }, State: { Status: 'running', Restarting: false, ExitCode: 0 }, RestartCount: 0 });
const update = (base: string, body: unknown) =>
  fetch(`${base}/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('update: anything but a strict vX.Y.Z is refused before Docker is called', async () => {
  await withFakeDocker([supervisor()], async (base, calls) => {
    for (const body of [{}, { version: 'latest' }, { version: '1.2.3' }, { version: 'v1.2' }, { version: 'v1.2.3-rc1' }, { version: 'v1.2.3; rm -rf /' }, { version: 3 }]) {
      const r = await update(base, body);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(((await r.json()) as { error: string }).error, 'refused');
    }
    assert.equal(calls.length, 0);
  });
});

test('update: the project labels become the binds, working dir and command', async () => {
  await withFakeDocker([...others(), supervisor()], async (base, calls, created) => {
    const r = await update(base, { version: 'v1.2.3' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { running: true, version: 'v1.2.3' });
    assert.ok(calls.some((c) => c.startsWith('POST /images/create?fromImage=docker%3Acli')));
    assert.equal(created.length, 1);
    const c = created[0] as { Image: string; Cmd: string[]; WorkingDir: string; Labels: Record<string, string>; HostConfig: { Binds: string[]; AutoRemove: boolean } };
    assert.equal(c.Image, 'docker:cli');
    assert.equal(c.WorkingDir, DIR);
    assert.deepEqual(c.Labels, { 'asf.updater': '1', 'asf.updater.version': 'v1.2.3' });
    assert.deepEqual(c.HostConfig, { Binds: ['/var/run/docker.sock:/var/run/docker.sock', `${DIR}:${DIR}`], AutoRemove: true });
    assert.deepEqual(c.Cmd, ['sh', '-c', updaterScript('v1.2.3', DIR, [`${DIR}/docker-compose.self-host.yml`, `${DIR}/docker-compose.host-worker.yml`])]);
    assert.ok(calls.includes('POST /containers/upd1/start'));
    // No compose container was started or restarted.
    assert.ok(calls.filter((c) => /\/(start|restart)$/.test(c)).every((c) => c.includes('/upd1/')));
  });
});

test('update: a second updater while one runs is refused', async () => {
  await withFakeDocker([supervisor()], async (base, _calls, created) => {
    assert.equal((await update(base, { version: 'v1.2.3' })).status, 200);
    const r = await update(base, { version: 'v1.2.4' });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { reason: string }).reason, /already running/);
    assert.equal(created.length, 1);
  });
});

test('update: refused without the compose project labels, nothing created', async () => {
  for (const labels of [{}, { 'com.docker.compose.project.working_dir': DIR }, { 'com.docker.compose.project.config_files': `${DIR}/a.yml` }] as Record<string, string>[]) {
    await withFakeDocker([supervisor(labels)], async (base, calls, created) => {
      const r = await update(base, { version: 'v1.2.3' });
      assert.equal(r.status, 409, JSON.stringify(labels));
      assert.equal(created.length, 0);
      assert.ok(!calls.some((c) => c.startsWith('POST')));
    });
  }
});

test('update: a pull that reports an error mid-stream is a 502, and no container is created', async () => {
  await withFakeDocker([supervisor()], async (base, _calls, created) => {
    const r = await update(base, { version: 'v1.2.3' });
    assert.equal(r.status, 502);
    assert.equal(((await r.json()) as { error: string }).error, 'docker_error');
    assert.equal(created.length, 0);
  }, { failPull: true });
});

test('GET /update: idle, then the running updater and its version', async () => {
  await withFakeDocker([...others(), supervisor()], async (base) => {
    assert.deepEqual(await (await fetch(`${base}/update`)).json(), { running: false, version: null });
    await update(base, { version: 'v2.0.0' });
    assert.deepEqual(await (await fetch(`${base}/update`)).json(), { running: true, version: 'v2.0.0' });
  });
});

test('updaterScript: paths with quotes and spaces stay single-quoted', () => {
  const dir = "/home/o'neil/my asf";
  const script = updaterScript('v1.2.3', dir, [`${dir}/docker-compose.self-host.yml`]);
  const q = "'/home/o'\\''neil/my asf'";
  assert.ok(script.includes(`cd ${q}\n`), script);
  assert.ok(script.includes(`--project-directory ${q} -f '/home/o'\\''neil/my asf/docker-compose.self-host.yml' pull && `), script);
  assert.ok(script.endsWith(' up -d'));
  assert.match(script, /^set -e\n/);
  assert.ok(script.includes('cat /tmp/asf.env > .env'));
});

test('updaterScript: pins ASF_VERSION in .env, replacing or appending, keeping the file itself', () => {
  const dir = mkdtempSync(join(tmpdir(), "asf upd'"));
  const scratch = mkdtempSync(join(tmpdir(), 'asf-upd-'));
  try {
    const run = (env: string) => {
      writeFileSync(join(dir, '.env'), env, { mode: 0o640 });
      // Run only the .env part (everything before the compose line).
      const script = updaterScript('v1.2.3', dir, ['x.yml']).split('\n').slice(0, -1).join('\n');
      execFileSync('sh', ['-c', script.split('/tmp/asf.env').join(join(scratch, 'tmp.env'))]);
      assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o640);
      return readFileSync(join(dir, '.env'), 'utf8');
    };
    assert.equal(run('A=1\nASF_VERSION=v0.1.0\nB=2\n'), 'A=1\nASF_VERSION=v1.2.3\nB=2\n');
    assert.equal(run('A=1\n'), 'A=1\nASF_VERSION=v1.2.3\n');
    assert.equal(run('A=1'), 'A=1\nASF_VERSION=v1.2.3\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
