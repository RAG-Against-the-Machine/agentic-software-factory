import type { TicketProvider } from '@asf/shared';

/**
 * Assign a ticket to the factory's configured identity, best-effort.
 *
 * Mirrors transitionTicketTo's discipline: a blank setting means "leave the
 * assignee alone" (the feature is off), and any failure — a tracker that can't
 * assign, an account it won't accept, a network error — is swallowed to
 * `false`. A status/assignee move must never fail a run that otherwise
 * succeeded. Returns whether an assign was actually issued and accepted at the
 * API level (note: a tracker may still silently drop an ineligible account —
 * assignment is a hint, not a guarantee).
 */
export async function assignTicketTo(
  tickets: Pick<TicketProvider, 'assign'>,
  ticketId: string,
  assignee: string,
): Promise<boolean> {
  const who = assignee.trim();
  if (!who) return false; // TICKET_ASSIGNEE blank → assignment disabled
  try {
    await tickets.assign(ticketId, who);
    return true;
  } catch {
    return false;
  }
}
