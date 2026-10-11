import { useState } from 'react';
import { api } from '../api';
import { useMe } from '../useMe';
import type { GateWire } from '@asf/shared';
import { gateTitle } from '../words';


/** A required gate the operator must answer. The plan gate lets them edit before approving. */
export function GateCard({ gate, onDone, changeRequestUrl }: { gate: GateWire; onDone: () => void; changeRequestUrl?: string | null }) {
  const me = useMe();
  const [note, setNote] = useState('');
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = gate.gateName === 'after_plan' && gate.artifact != null;
  const content = edited ?? gate.artifact ?? '';

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    await api.resolveGate(gate.id, decision, me.user, note || undefined, editable && edited != null ? edited : undefined).catch(() => {});
    setBusy(false); onDone();
  };

  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <div className="row between">
        <b>⏸ {gateTitle(gate.gateName)}</b>
        <span className="pill awaiting_checkpoint">waiting on you</span>
      </div>
      {(gate.gateName === 'before_merge' || gate.gateName === 'before_change_request') && changeRequestUrl && (
        <div style={{ marginTop: 8 }}>Review the change: <a href={changeRequestUrl} target="_blank" rel="noreferrer">{changeRequestUrl}</a></div>
      )}
      {gate.artifact != null && (
        editable
          ? <textarea rows={12} value={content} onChange={(e) => setEdited(e.target.value)} style={{ marginTop: 10 }} />
          : <pre className="artifact" style={{ marginTop: 10 }}>{gate.artifact}</pre>
      )}
      <input placeholder="Note (sent to the agent on reject)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', margin: '10px 0' }} />
      <div className="row">
        <button className="btn good" disabled={busy} onClick={() => decide('approve')}>{editable && edited != null ? 'Approve edited' : 'Approve'}</button>
        <button className="btn bad" disabled={busy} onClick={() => decide('reject')}>Reject &amp; revise</button>
      </div>
    </div>
  );
}
