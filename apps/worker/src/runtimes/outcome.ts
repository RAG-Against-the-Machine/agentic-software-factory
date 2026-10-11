import type { AgentOutcome } from '@asf/shared';
import { NOT_NEEDED_PREFIX } from '@asf/shared';

/**
 * The role's own final text -> an outcome, shared by every runtime. A text with a
 * line beginning NEEDS_HUMAN: is the role's signal that a person is needed — the
 * same protocol the prompts describe — and becomes `needs_human`. DISPUTE: is the
 * implementer rejecting a review finding; same machinery, tagged for the UI.
 */
export function outcomeFromText(text: string): Pick<AgentOutcome, 'outcome' | 'text'> {
  // NOT_NEEDED: the role found the ticket's work already done, or the problem doesn't
  // arise. Parks like a question (a person confirms and cancels, or says go ahead), tagged
  // `NOT NEEDED:` so the UI offers to cancel the job. Checked first: it's the verdict.
  if (/^\s*NOT_NEEDED:/m.test(text)) {
    const from = text.slice(text.search(/^\s*NOT_NEEDED:/m));
    return { outcome: 'needs_human', text: `${NOT_NEEDED_PREFIX} ${from.replace(/^\s*NOT_NEEDED:\s*/, '').trim()}` };
  }
  if (/^\s*NEEDS_HUMAN:/m.test(text)) {
    // Everything from the marker on: a planner may ask several numbered questions,
    // one per line, and a person needs all of them — not just the first line.
    const from = text.slice(text.search(/^\s*NEEDS_HUMAN:/m));
    return { outcome: 'needs_human', text: from.replace(/^\s*NEEDS_HUMAN:\s*/, '').trim() };
  }
  // DISPUTE: the implementer rejects a review finding as wrong/contradictory. Same
  // machinery as needs_human (inbox, notification, answer, skip all work), tagged
  // so the UI can show it as a dispute rather than an open question (M11 WP4).
  if (/^\s*DISPUTE:/m.test(text)) {
    const line = text.split('\n').find((l) => /DISPUTE:/.test(l)) ?? text;
    return { outcome: 'needs_human', text: `DISPUTE: ${line.replace(/^\s*DISPUTE:\s*/, '').trim()}` };
  }
  return { outcome: 'done', text };
}
