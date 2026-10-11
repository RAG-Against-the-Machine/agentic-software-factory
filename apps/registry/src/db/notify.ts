import type { Sql } from './pool.js';

/**
 * One LISTEN connection per registry process. `appendEvent` NOTIFYs
 * `run_events` with "<runId>:<seq>"; subscribers (the SSE route) look the row
 * up and re-broadcast. Polling run_events for fan-out is what makes a board
 * feel laggy, and it breaks the moment there are two api instances.
 */
export type RunEventListener = (runId: string, seq: number) => void;

export async function listenRunEvents(sql: Sql, listener: RunEventListener): Promise<{ unlisten: () => Promise<void> }> {
  const { unlisten } = await sql.listen('run_events', (payload) => {
    const idx = payload.lastIndexOf(':');
    if (idx <= 0) return;
    listener(payload.slice(0, idx), Number(payload.slice(idx + 1)));
  });
  return { unlisten };
}
