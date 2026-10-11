import type { FleetWire, TodayWire } from '@asf/shared';

/**
 * The sidebar's worker chip: "1 online · 2/4 busy" (the chip draws the ● in
 * front), or a warning when no worker is online. Pure so the wording is tested
 * without a browser.
 */
export function workerSummary(fleet: Pick<FleetWire, 'workers' | 'capacity' | 'running'>): { online: boolean; text: string } {
  const n = fleet.workers.length;
  if (n === 0) return { online: false, text: 'No worker online' };
  return { online: true, text: `${n} online · ${fleet.running}/${fleet.capacity} busy` };
}

/** Today's spend: what the running jobs and the ones finished today have cost so far. */
export function todaySpendUsd(today: Pick<TodayWire, 'running' | 'doneToday'>): number {
  return [...today.running, ...today.doneToday].reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
}

/** The spend chip's label, e.g. "$1.25 today". */
export function spendText(usd: number): string {
  return `$${usd.toFixed(2)} today`;
}
