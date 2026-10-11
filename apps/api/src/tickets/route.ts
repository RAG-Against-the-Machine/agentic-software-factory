import { isAdhocId } from '@asf/shared';
import type { TicketProvider } from '@asf/shared';
import { adhocTickets } from '../providers/tickets/index.js';

/**
 * Which provider owns a ticket id: the ad-hoc store for an `adhoc:` id (#179),
 * the configured tracker for everything else. Every place that acts on a run's
 * or a dispatch's ticket goes through this, so an ad-hoc task never reaches the
 * tracker (no lookup, comment, transition or assign against it).
 */
export function ticketsFor(tracker: TicketProvider, id: string): TicketProvider {
  return isAdhocId(id) ? adhocTickets : tracker;
}
