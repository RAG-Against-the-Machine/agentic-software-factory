import type { CredentialHealthWire } from '@asf/shared';
import type { Db, Sql } from '../db/pool.js';
import { recordNotification } from '../runs/notification-store.js';

/**
 * Credential health (#139). The api live-checks each tracker/SCM credential and
 * records the result here by setting key. A failing credential raises exactly
 * ONE notification (no run attached) for the whole failure: alerted_at is set by
 * a conditional update, so concurrent checks cannot both alert. A recovery, or
 * re-saving the secret (resetCredentialHealth), clears failing_since and
 * alerted_at so the next failure alerts again.
 */

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
function toWire(r: Record<string, unknown>): CredentialHealthWire {
  return {
    key: String(r.key), ok: Boolean(r.ok), reason: r.reason == null ? null : String(r.reason),
    failingSince: iso(r.failingSince), alertedAt: iso(r.alertedAt), checkedAt: iso(r.checkedAt)!,
  };
}

export async function recordCredentialHealth(sql: Sql, h: { key: string; ok: boolean; reason: string | null; label: string; link: string }): Promise<CredentialHealthWire> {
  if (h.ok) {
    const [row] = await sql`INSERT INTO credential_health (key, ok, reason, failing_since, alerted_at, checked_at)
      VALUES (${h.key}, true, null, null, null, now())
      ON CONFLICT (key) DO UPDATE SET ok = true, reason = null, failing_since = null, alerted_at = null, checked_at = now()
      RETURNING *`;
    return toWire(row);
  }
  return sql.begin(async (tx: Db) => {
    await tx`INSERT INTO credential_health (key, ok, reason, failing_since, checked_at)
      VALUES (${h.key}, false, ${h.reason}, now(), now())
      ON CONFLICT (key) DO UPDATE SET ok = false, reason = EXCLUDED.reason,
        failing_since = COALESCE(credential_health.failing_since, now()), checked_at = now()`;
    const alerted = await tx`UPDATE credential_health SET alerted_at = now()
      WHERE key = ${h.key} AND alerted_at IS NULL RETURNING key`;
    if (alerted.length) {
      await recordNotification(tx, {
        runId: null, kind: 'credential',
        title: `Your ${h.label} stopped working`,
        body: `${h.reason ?? 'The connection test failed.'} Runs that need it will fail until you save a new one in Settings.`,
        actions: [{ label: 'Fix in Settings', url: h.link }],
      });
    }
    const [row] = await tx`SELECT * FROM credential_health WHERE key = ${h.key}`;
    return toWire(row);
  }) as Promise<CredentialHealthWire>;
}

/** A re-saved (or cleared) secret starts over: its next failure alerts again. */
export async function resetCredentialHealth(sql: Sql, key: string): Promise<void> {
  await sql`DELETE FROM credential_health WHERE key = ${key}`;
}

export async function listCredentialHealth(sql: Sql): Promise<CredentialHealthWire[]> {
  return (await sql`SELECT * FROM credential_health ORDER BY key`).map(toWire);
}
