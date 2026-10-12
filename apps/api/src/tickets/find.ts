import { ticketRefCandidates } from '@asf/shared';
import type { Ticket } from '@asf/shared';

/**
 * Find tickets by number anywhere in the tracker, not just in the board/sprint the
 * Planned tasks page has loaded (and including done ones). `get` is the tracker's
 * single-ticket read; a candidate that doesn't exist (404) or can't be read is skipped.
 */
export async function findTicketsByRef(
  get: (id: string) => Promise<Ticket>,
  search: string,
  prefixes: readonly string[],
): Promise<Ticket[]> {
  const ids = ticketRefCandidates(search, prefixes);
  const found = await Promise.all(ids.map((id) => get(id).catch(() => null)));
  const out: Ticket[] = [];
  const seen = new Set<string>();
  for (const t of found) if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
  return out;
}
