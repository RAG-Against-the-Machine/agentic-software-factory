/**
 * apps/registry — the fleet's single source of truth.
 *
 * Only this process opens DATABASE_URL. Holds no ticket or SCM credential and
 * serves no UI. Owns: runs, run_task, run_events, worker; the deterministic
 * orchestrator (runs/orchestrate.ts); the claim query (FOR UPDATE SKIP
 * LOCKED); the stale sweeper; LISTEN/NOTIFY -> SSE fan-out.
 */
import './boot-secrets.js';
import { buildServer } from './server.js';
import { config } from './config.js';

const { app } = await buildServer();
await app.listen({ port: config.port, host: config.host });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
