import { useState } from 'react';
import { api } from '../api';
import { useMe } from '../useMe';

/**
 * An agent checked and found the ticket's work already done, or the problem doesn't
 * arise (it replied NOT_NEEDED:). The person confirms: cancel the job, and for a task
 * the factory filed itself (ad-hoc), remove it too so it isn't picked up again.
 * Disagreeing is just a reply in the chat / answer box ("do it anyway, because …").
 */
export function NotNeededActions({ runId, ticketId, ticketKey, onDone }: {
  runId: string; ticketId: string; ticketKey: string; onDone: () => void;
}) {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const adhoc = ticketId.startsWith('adhoc:');

  const cancel = async (remove: boolean) => {
    setBusy(true); setErr(null);
    try {
      await api.cancel(runId, me.user);
      if (remove) {
        const res = await api.deleteAdhoc(ticketId);
        if (res.status >= 400 && res.status !== 404) setErr(`The job was cancelled, but ${ticketKey} couldn't be removed (${res.status}).`);
      }
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false); onDone();
  };

  return (
    <div className="not-needed">
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        Agree? Cancel the job. Think it's still needed? Say why below and it carries on.
      </div>
      <div className="row">
        {adhoc && <button className="btn bad" disabled={busy} onClick={() => cancel(true)}>Cancel job &amp; remove {ticketKey}</button>}
        <button className={adhoc ? 'btn ghost' : 'btn bad'} disabled={busy} onClick={() => cancel(false)}>{adhoc ? 'Cancel job, keep the task' : 'Cancel job'}</button>
      </div>
      {err && <div style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}
