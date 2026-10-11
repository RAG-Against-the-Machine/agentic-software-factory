import { useState } from 'react';
import { api } from '../api';
import type { RunTask } from '@asf/shared';
import { isNotNeeded, notNeededReason } from '@asf/shared/ui';
import { NotNeededActions } from './NotNeededActions';
import { useMe } from '../useMe';

/**
 * The needs-human inbox for a run (M6 WP6.4). When a role parks with a question,
 * this shows the question and lets a person answer (re-running the role with the
 * reply as {{prior.humanReply}}) or skip the role entirely.
 */
export function NeedsHumanCard({ runId, ticketId, ticketKey, task, onDone }: {
  runId: string; ticketId: string; ticketKey: string; task: RunTask; onDone: () => void;
}) {
  const me = useMe();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const answer = async () => {
    if (!reply.trim()) return;
    setBusy(true); setErr(null);
    const res = await api.answer(runId, reply, me.user);
    setBusy(false);
    if (res.status >= 400) { setErr(res.body?.reason ?? `failed (${res.status})`); return; }
    setReply(''); onDone();
  };
  const skip = async () => {
    setBusy(true); setErr(null);
    const res = await api.skipRole(runId, me.user);
    setBusy(false);
    if (res.status >= 400) { setErr(res.body?.reason ?? `failed (${res.status})`); return; }
    onDone();
  };

  const raw = task.reason ?? 'The agent paused and needs a person to weigh in.';
  const notNeeded = isNotNeeded(raw);
  const reason = notNeeded ? notNeededReason(raw) : raw;
  const isDispute = /^DISPUTE:/i.test(reason);
  const isRepeat = /repeated the same blocker|reviewer escalated/i.test(reason);
  const header = notNeeded
    ? `🛑 The ${String(task.role)} thinks this work isn't needed`
    : isDispute
    ? `⚖️ ${String(task.role)} disputes the review — you decide`
    : isRepeat
      ? '🔁 Reviewer and implementer are stuck — you decide'
      : `✋ The ${String(task.role)} has a question for you`;

  return (
    <div className="card" style={{ outline: '2px solid var(--warn,#fbbf24)' }}>
      <div className="row between"><b>{header}</b><span className="muted">try {task.attempt}</span></div>
      <div className="muted" style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{reason}</div>
      {(isDispute || isRepeat) && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          The change was not accepted after review. Answer to steer the next attempt, or skip the role to accept the work as-is and move on.
        </div>
      )}
      {notNeeded && <NotNeededActions runId={runId} ticketId={ticketId} ticketKey={ticketKey} onDone={onDone} />}
      <textarea rows={3} placeholder={notNeeded ? 'Still needed? Say why and it carries on…' : 'Your answer — the role re-runs with this as context…'} value={reply} onChange={(e) => setReply(e.target.value)} disabled={busy} />
      {err && <div style={{ color: 'var(--bad)', marginTop: 6 }}>{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn good" onClick={answer} disabled={busy || !reply.trim()}>Answer &amp; re-run</button>
        <button className="btn ghost" onClick={skip} disabled={busy}>Skip this role</button>
      </div>
    </div>
  );
}
