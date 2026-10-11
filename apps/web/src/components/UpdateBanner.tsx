import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@asf/shared';
import { api } from '../api';
import { bannerVisible, clearDismissed, onUpdateStatus, readDismissed, restartDone, versionLabel, writeDismissed } from '../updates-view';

const POLL_MS = 3_000;
const GIVE_UP_MS = 10 * 60_000;

const storage = () => { try { return window.localStorage; } catch { return null; } };

type Phase = 'idle' | 'confirm' | 'applying' | 'restarting' | 'slow';

/**
 * "A newer ASF is out" (ADHOC-CDBC5883), above every page. Dismissing remembers the
 * version, so a newer release shows it again. With a supervisor sidecar it can apply
 * the update and waits for the app to come back on the new version; without one it
 * shows the command to run on the server.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed(storage()));
  const [phase, setPhase] = useState<Phase>('idle');
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => { api.updates().then(setStatus, () => { /* no banner without a status */ }); }, []);

  // Settings → "Check now" publishes its result. An explicit check that finds an update
  // shows the banner again, even for a version dismissed before.
  useEffect(() => onUpdateStatus(window, (s) => {
    setStatus(s);
    if (s.available) { clearDismissed(storage()); setDismissed(null); }
  }), []);

  // After a successful apply: poll until the app answers with a different version, then reload.
  // Errors are expected while the api restarts, so they are ignored.
  const prev = status?.current;
  useEffect(() => {
    if (phase !== 'restarting' || prev === undefined) return;
    const started = Date.now();
    let stopped = false;
    const id = window.setInterval(async () => {
      if (Date.now() - started > GIVE_UP_MS) { window.clearInterval(id); setPhase('slow'); return; }
      try {
        // /health is a cheap liveness probe; the version from /api/updates decides.
        const [, s] = await Promise.all([api.health().catch(() => null), api.updates()]);
        if (!stopped && restartDone(prev, s)) { stopped = true; window.clearInterval(id); window.location.reload(); }
      } catch { /* restarting */ }
    }, POLL_MS);
    return () => { stopped = true; window.clearInterval(id); };
  }, [phase, prev]);

  const inFlight = phase === 'applying' || phase === 'restarting' || phase === 'slow';
  if (!status || (!inFlight && !bannerVisible(status, dismissed))) return null;

  const label = versionLabel(status.current, status.latest);
  const dismiss = () => { if (status.latest) { writeDismissed(storage(), status.latest); setDismissed(status.latest); } };
  const apply = async () => {
    setPhase('applying'); setReason(null);
    try {
      const r = await api.applyUpdate();
      if (r.status >= 200 && r.status < 300 && r.body.started) { setPhase('restarting'); return; }
      setReason(r.body.reason ?? `The update didn’t start (HTTP ${r.status}).`);
    } catch (e) {
      setReason((e as Error).message);
    }
    setPhase('idle');
  };

  return (
    <div className="notice update-banner" role="status">
      <span>
        <b>A new version of ASF is available: <span className="mono">{label}</span></b>
        {phase === 'restarting' && <span>Updating… the app will restart. This page reloads by itself when it’s back.</span>}
        {phase === 'slow' && <span className="warn">This is taking longer than expected. Refresh the page in a minute, or check the server.</span>}
        {!inFlight && !status.canApply && (
          <span className="muted">To update, run <code className="mono update-cmd">scripts/asf update</code> on the server.</span>
        )}
        {reason && <span className="bad" role="alert">{reason}</span>}
      </span>
      <span className="update-actions">
        {status.canApply && phase === 'idle' && <button type="button" className="btn sm" onClick={() => setPhase('confirm')}>Update now</button>}
        {phase === 'confirm' && (
          <>
            <span className="muted">Restart on {status.latest ? versionLabel(status.latest, null) : 'the new version'}?</span>
            <button type="button" className="btn sm" onClick={apply}>Confirm</button>
            <button type="button" className="btn ghost sm" onClick={() => setPhase('idle')}>Cancel</button>
          </>
        )}
        {phase === 'applying' && <button type="button" className="btn sm" disabled>Starting…</button>}
        {!inFlight && <button type="button" className="link-btn update-dismiss" aria-label={`Dismiss the update notice for ${status.latest ?? 'this version'}`} onClick={dismiss}>×</button>}
      </span>
    </div>
  );
}
