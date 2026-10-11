import type { SplitFamilyWire, SplitPartWire } from '@asf/shared/ui';

/**
 * Where a part of a split stands, in words, for the run page (#split UX). Pure, so
 * it is unit-tested without a DOM. Order matters: merged beats everything, a live
 * run beats the queue, and waiting-on-a-merge is spelled out with the keys.
 */
export type PartTone = 'done' | 'running' | 'waiting' | 'attention' | 'idle';
export interface PartStatus { label: string; tone: PartTone }

export function partStatus(p: SplitPartWire): PartStatus {
  if (p.merged) return { label: 'Merged', tone: 'done' };
  const r = p.run;
  if (r) {
    if (r.changeRequestState === 'closed') return { label: 'Pull request closed without merging', tone: 'attention' };
    if (r.deliveryOutcome === 'awaiting_external_merge' || (r.changeRequestUrl && r.state === 'succeeded')) return { label: 'Pull request ready to merge', tone: 'attention' };
    switch (r.state) {
      case 'awaiting_checkpoint': return { label: 'Waiting on you', tone: 'attention' };
      case 'running': case 'queued': return { label: 'In progress', tone: 'running' };
      case 'failed': case 'halted': return { label: r.state === 'failed' ? 'Failed' : 'Stopped', tone: 'attention' };
      case 'stale': return { label: 'Stalled', tone: 'attention' };
      case 'cancelled': return { label: 'Cancelled', tone: 'attention' };
      case 'succeeded': return { label: 'Done', tone: 'done' };
    }
  }
  if (p.queueState === 'queued') {
    return p.waitingOn.length
      ? { label: `Waiting for ${p.waitingOn.join(', ')} to merge`, tone: 'waiting' }
      : { label: 'Up next, starting soon', tone: 'idle' };
  }
  if (p.queueState === 'cancelled') return { label: 'Removed from Up next', tone: 'attention' };
  if (p.queueState === 'failed') return { label: "Couldn't start", tone: 'attention' };
  return { label: 'Not started', tone: 'idle' };
}

/** "2 of 4 merged" — the one-line progress for the split card's header. */
export function splitProgress(f: SplitFamilyWire): string {
  const merged = f.parts.filter((p) => p.merged).length;
  return merged === f.parts.length ? `All ${f.parts.length} merged` : `${merged} of ${f.parts.length} merged`;
}
