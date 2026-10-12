/**
 * Ticket search by number (Planned tasks). Searching used to match the title only,
 * and only within the tickets already loaded for the selected board/sprint, so typing
 * a ticket number ("DCP-1234", or just "1234") found nothing.
 */

/** A Jira-style key: letters/digits/underscore, a dash, a number ("DCP-1234"). */
const KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;
/** A bare ticket number, optionally with a leading '#' ("1234", "#1234"). */
const NUMBER = /^#?(\d+)$/;

/** Does a loaded ticket match the search text (key, number or title words)? */
export function ticketMatches(t: { key: string; title: string }, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const key = t.key.toLowerCase();
  if (key === q || key.includes(q)) return true;
  const n = NUMBER.exec(q);
  if (n && (key.endsWith(`-${n[1]}`) || key.endsWith(`#${n[1]}`))) return true;
  return t.title.toLowerCase().includes(q);
}

/** Does the search text look like a ticket number or key (worth a direct lookup)? */
export function looksLikeTicketRef(search: string): boolean {
  const q = search.trim();
  return KEY.test(q) || NUMBER.test(q) || /^[^\s#]+\/[^\s#]+#\d+$/.test(q);
}

/**
 * Ticket ids to look up directly for a search: the key itself, or for a bare number
 * the number under each known project prefix. Capped so a search can't fan out.
 */
export function ticketRefCandidates(search: string, prefixes: readonly string[], max = 5): string[] {
  const q = search.trim();
  const k = KEY.exec(q);
  if (k) return [`${k[1]!.toUpperCase()}-${k[2]}`];
  if (/^[^\s#]+\/[^\s#]+#\d+$/.test(q)) return [q];
  const n = NUMBER.exec(q);
  if (!n) return [];
  const seen = new Set<string>();
  for (const p of prefixes) {
    const up = p.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]*$/.test(up)) seen.add(`${up}-${n[1]}`);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Project prefixes seen in a list of ticket keys ("DCP-12" -> "DCP"). */
export function keyPrefixes(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) { const m = KEY.exec(k); if (m) out.add(m[1]!.toUpperCase()); }
  return [...out];
}
