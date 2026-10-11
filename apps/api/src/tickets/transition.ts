import type { TicketProvider, TicketTransition } from '@asf/shared';

/**
 * Move a ticket to the first status matching one of `preferred`.
 *
 * The tracker's transitions are read live, never configured: a Jira transition
 * id is per-workflow and a status name is per-project, so hardcoding "31" works
 * until the second project and hardcoding "In Review" works until someone
 * renames a column. `preferred` is a list of synonyms (from a TICKET_STATUS_*
 * setting) matched case-insensitively against BOTH the transition name and its
 * destination status; the first available match wins.
 *
 * Returns the status it moved to, or null. **Null is not an error.** A project
 * whose workflow has no "In Review" is a project where the run's other signals
 * (the PR link, the comment) are the whole notification, and failing the run
 * over a column that does not exist would be absurd. Every failure — no match,
 * a transitions() that throws, a transition() the account may not perform — is
 * swallowed to null so a status move can never break a run that otherwise
 * succeeded.
 */
export async function transitionTicketTo(
  tickets: Pick<TicketProvider, 'transitions' | 'transition'>,
  ticketId: string,
  preferred: readonly string[],
): Promise<string | null> {
  const wanted = preferred.map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return null; // the setting is blank → this move is disabled

  let available: TicketTransition[];
  try {
    available = await tickets.transitions(ticketId);
  } catch {
    return null;
  }

  const match = pickTransition(available, wanted);
  if (!match) return null;

  try {
    await tickets.transition(ticketId, match.id);
  } catch {
    return null;
  }
  return match.toStatus || match.name;
}

/** First transition whose name or destination status matches a preferred name. */
export function pickTransition(
  available: readonly TicketTransition[],
  wantedLower: readonly string[],
): TicketTransition | null {
  for (const want of wantedLower) {
    const hit = available.find(
      (t) => t.name.toLowerCase() === want || (t.toStatus ?? '').toLowerCase() === want,
    );
    if (hit) return hit;
  }
  return null;
}

/** Split a TICKET_STATUS_* setting value into trimmed, non-empty synonyms. */
export function parsePreferredStatuses(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
