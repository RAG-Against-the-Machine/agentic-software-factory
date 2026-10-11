import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

const UP = './scripts/asf up';

/**
 * Shown when no worker is online (#135): explains why, and — when the self-host
 * supervisor is there — offers to start the stopped worker container. The fleet /
 * setup-status polls on the page pick up the worker once it registers.
 */
export function LocalWorkerHelp() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['local-worker'], queryFn: api.localWorker, refetchInterval: 5_000 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setBusy(true); setErr(null);
    try { qc.setQueryData(['local-worker'], await api.startLocalWorker()); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const state = data?.available ? data.state : 'missing';
  return (
    <div>
      {state === 'exited' && (
        <>
          <p style={{ marginTop: 0 }}><b>Worker stopped.</b></p>
          <button className="btn sm" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start a worker'}</button>
        </>
      )}
      {state === 'restarting' && (
        <>
          <p style={{ marginTop: 0 }}><b>Worker keeps failing to start</b> — usually its AI access. Check <Link to="/settings#ai">Settings → AI</Link>, then restart it.</p>
          <button className="btn sm" disabled={busy} onClick={start}>{busy ? 'Restarting…' : 'Restart'}</button>
        </>
      )}
      {state === 'running' && <p className="muted small" style={{ margin: 0 }}>The worker is starting; it appears here within a few seconds.</p>}
      {state === 'missing' && <CopyUp />}
      {err && <div className="bad small" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function CopyUp() {
  const [copied, setCopied] = useState(false);
  return (
    <p className="muted small" style={{ margin: 0 }}>
      Whoever installed the factory can start one with <span className="mono">{UP}</span>{' '}
      <button className="btn ghost sm" onClick={() => { void navigator.clipboard.writeText(UP); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied ✓' : 'Copy'}</button>
    </p>
  );
}
