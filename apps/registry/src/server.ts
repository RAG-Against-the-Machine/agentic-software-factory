import Fastify from 'fastify';
import { config, resolveSecret } from './config.js';
import { sql, ping, closePool } from './db/pool.js';
import { migrate, MIGRATIONS_DIR } from './db/migrate.js';
import { installAuth } from './auth.js';
import { registerRpc } from './routes/rpc.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerStream } from './routes/stream.js';
import { startSweeper } from './runs/sweeper.js';
import { startRecurringTicker } from './runs/recurring-store.js';

export async function buildServer(opts: { secret?: string; migrate?: boolean; sweeper?: boolean; recurring?: boolean; databaseUrl?: string; schema?: string } = {}) {
  // forceCloseConnections: the SSE route holds a request open forever by
  // design; close() must not wait for it.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, forceCloseConnections: true });
  const db = sql({ url: opts.databaseUrl, schema: opts.schema });

  if (!(await ping())) {
    app.log.error({ databaseUrl: config.databaseUrl.replace(/:\/\/.*@/, '://***@') }, 'database unreachable');
    throw new Error('database unreachable; a registry with no database would accept a dispatch and lose it');
  }
  let migrations = 0;
  if (opts.migrate ?? config.migrate) {
    const r = await migrate(db, MIGRATIONS_DIR);
    migrations = r.total;
    app.log.info({ applied: r.applied, total: r.total }, 'migrations');
  }

  const { secret, generated } = opts.secret ? { secret: opts.secret, generated: false } : resolveSecret();
  if (generated) app.log.warn({ RUN_EVENT_SECRET: secret }, 'RUN_EVENT_SECRET was blank; generated one for this process (set it in .env for workers on other hosts)');
  installAuth(app, secret);

  app.get('/health', async () => ({ ok: true, db: await ping(), migrations }));
  registerRpc(app, db);
  registerWorkerRoutes(app, db);
  const closeStream = await registerStream(app, db);
  const stopSweeper = (opts.sweeper ?? true) ? startSweeper(db, app.log) : () => {};
  const stopRecurring = (opts.recurring ?? true) ? startRecurringTicker(db, app.log, config.reconcileIntervalMs) : () => {};

  app.addHook('onClose', async () => { stopSweeper(); stopRecurring(); await closeStream(); await closePool(); });
  return { app, secret };
}
