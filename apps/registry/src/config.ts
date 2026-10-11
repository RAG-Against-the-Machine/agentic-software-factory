import { randomBytes } from 'node:crypto';
import { resolve } from '@asf/shared';

/**
 * Every value comes through the settings catalogue (packages/shared/src/settings.ts),
 * which is what .env.example and docs/CONFIGURATION.md are generated from.
 * PORT (injected by Cloud Run / most PaaS) overrides REGISTRY_PORT and implies
 * binding 0.0.0.0; otherwise the default is loopback.
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : null;

export const config = {
  databaseUrl: resolve('DATABASE_URL'),
  port: PORT ?? resolve('REGISTRY_PORT'),
  host: process.env.REGISTRY_HOST ? resolve('REGISTRY_HOST') : PORT ? '0.0.0.0' : resolve('REGISTRY_HOST'),
  databaseSchema: resolve('DATABASE_SCHEMA'),
  migrate: resolve('DATABASE_MIGRATE'),
  runEventSecret: resolve('RUN_EVENT_SECRET'),
  staleAfterMin: resolve('STALE_AFTER_MIN'),
  workerTtlSeconds: resolve('WORKER_TTL_SECONDS'),
  reconcileIntervalMs: resolve('RECONCILE_INTERVAL_MS'),
  eventRetentionDays: resolve('EVENT_RETENTION_DAYS'),
  loopRepeatDetect: resolve('LOOP_REPEAT_DETECT'),
};

export function resolveSecret(): { secret: string; generated: boolean } {
  if (config.runEventSecret) return { secret: config.runEventSecret, generated: false };
  return { secret: randomBytes(24).toString('hex'), generated: true };
}
