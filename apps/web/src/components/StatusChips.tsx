import { useEffect, useRef, useState } from 'react';
import { api, type Fleet } from '../api';
import { spendText, todaySpendUsd, workerSummary } from '../status-chips';
import { LocalWorkerHelp } from './LocalWorkerHelp';

/**
 * Two glanceable chips in the sidebar footer (they replace the old Workers page):
 * worker status ("● 1 online · 2/4 busy", or a warning) and today's spend. The
 * worker tooltip carries the per-worker detail and the month's spend; with no
 * worker online, a click opens the "start a worker" help. On the tablet icon rail
 * each chip shrinks to its dot.
 */
export function StatusChips() {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [spend, setSpend] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      api.fleet().then(setFleet).catch(() => {});
      api.today().then((t) => setSpend(todaySpendUsd(t))).catch(() => {});
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const w = fleet ? workerSummary(fleet) : null;
  const workerTitle = fleet && [
    ...fleet.workers.map((x) => `${x.id}: ${x.running} of ${x.maxConcurrent} busy · seen ${new Date(x.lastHeartbeat).toLocaleTimeString()}`),
    `Spent this month: $${fleet.monthCostUsd.toFixed(2)}`,
    ...(fleet.monthUnpricedRuns ? [`Unpriced runs this month: ${fleet.monthUnpricedRuns} (not in the spend)`] : []),
  ].join('\n');

  return (
    <div className="status-chips" ref={ref}>
      {w && (
        <button
          className={`status-chip${w.online ? '' : ' warn'}`}
          title={w.online ? workerTitle ?? undefined : `${workerTitle}\nClick for how to start one`}
          onClick={() => { if (!w.online) setOpen((o) => !o); }}
        >
          <span className={`dot ${w.online ? 'done' : 'awaiting_gate'}`} /><span className="chip-label">{w.text}</span>
        </button>
      )}
      {spend != null && (
        <span className="status-chip" title={`${spendText(spend)}: what running jobs and jobs finished today have cost`}>
          <span className="dot pending" /><span className="chip-label">{spendText(spend)}</span>
        </span>
      )}
      {open && w && !w.online && (
        <div className="card status-pop">
          <p style={{ marginTop: 0 }}><b>No worker is online.</b> Tickets you send will wait in line until one starts.</p>
          <LocalWorkerHelp />
        </div>
      )}
    </div>
  );
}
