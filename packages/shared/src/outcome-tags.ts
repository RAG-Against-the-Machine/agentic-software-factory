/**
 * Tags on a parked task's reason (and the planner's chat message) that say what kind
 * of stop it is. The worker writes them; the web reads them. Browser-safe.
 */

/** The role found the ticket's work already done, or the problem doesn't arise. */
export const NOT_NEEDED_PREFIX = 'NOT NEEDED:';

export const isNotNeeded = (text: string | null | undefined): boolean => (text ?? '').trimStart().startsWith(NOT_NEEDED_PREFIX);

/** The evidence after the tag. */
export const notNeededReason = (text: string): string => text.trimStart().slice(NOT_NEEDED_PREFIX.length).trim();
