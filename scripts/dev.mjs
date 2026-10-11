#!/usr/bin/env node
/**
 * One command to run the current slice locally: registry (:8788) -> api (:8787)
 * -> one worker, each waited on before the next starts. Ctrl-C stops all three.
 *
 *   node scripts/dev.mjs                # mock providers, real Claude Code worker
 *   node scripts/dev.mjs --no-worker    # registry + api only (no agent spend)
 *
 * Prereqs: Postgres up (`pnpm db:up`), `@asf/shared` built (`pnpm --filter
 * @asf/shared build`), and for a *successful* agent run, `claude` logged in.
 * Reads .env if present; fills a dev RUN_EVENT_SECRET when blank.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const noWorker = flags.has('--no-worker');

// --- load .env (simple KEY=VALUE, ignores comments) into a base env ---
const env = { ...process.env };
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2].replace(/\s+#.*$/, '');
  }
}
if (!env.RUN_EVENT_SECRET) { env.RUN_EVENT_SECRET = 'dev-secret'; console.log('[dev] RUN_EVENT_SECRET blank -> using "dev-secret" for this session'); }
env.LOG_LEVEL ??= 'info';

const children = [];
function startWeb() {
  const child = spawn('npx', ['vite', '--port', '3999'], { cwd: join(root, 'apps/web'), env, stdio: 'inherit' });
  children.push(child);
}
function start(name, cwd, extra = {}) {
  const child = spawn('npx', ['tsx', 'src/index.ts'], { cwd: join(root, cwd), env: { ...env, ...extra }, stdio: 'inherit' });
  child.on('exit', (code) => { if (code) console.error(`[dev] ${name} exited (${code})`); });
  children.push(child);
  return child;
}

async function waitHealthy(url, name, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'x-run-secret': env.RUN_EVENT_SECRET } }); if (r.ok) { console.log(`[dev] ${name} healthy`); return; } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`[dev] ${name} did not become healthy at ${url}`);
}

const shutdown = () => { console.log('\n[dev] stopping'); for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[dev] starting registry -> api' + (noWorker ? '' : ' -> worker'));
start('registry', 'apps/registry');
await waitHealthy(`${env.REGISTRY_URL ?? 'http://127.0.0.1:8788'}/health`, 'registry');
start('api', 'apps/api');
await waitHealthy(`${env.API_URL ?? 'http://127.0.0.1:8787'}/health`, 'api');
if (!noWorker) start('worker', 'apps/worker');
if (!flags.has('--no-web')) startWeb();

console.log('\n[dev] up.  registry :8788  api :8787  web :3999' + (noWorker ? '  (no worker)' : '  worker: polling'));
console.log('[dev] open:  http://localhost:3999');
console.log('[dev] drive a full run:  RUN_EVENT_SECRET=' + env.RUN_EVENT_SECRET + ' node scripts/m2-smoke.mjs');
console.log('[dev] Ctrl-C to stop.');
