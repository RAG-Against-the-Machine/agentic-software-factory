import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ADHOC_DEFAULT_LIMITS, type AdhocLimits } from '@asf/shared/ui';
import { api, encodeTicketId } from '../api';
import { adhocNext, formatBytes, mimeOf, newTaskProblem, TITLE_MAX } from '../new-task';
import { PAGE } from '../words';
import { SetupNotice } from '../components/q/SetupNotice';

interface Picked { key: number; file: File; mime: string; preview: string | null }

/** The file's bytes as base64 (the data: URL minus its prefix). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/**
 * New task (#179): work that has no ticket in the tracker. A title, a Markdown
 * description and any screenshots or files (drop, paste or pick). Submitting
 * stores it as an ad-hoc task and opens the ordinary Start screen for it
 * (repository, models, check-ins); the conversation carries on in the plan chat.
 */
export function NewTask() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [limits, setLimits] = useState<AdhocLimits>(ADHOC_DEFAULT_LIMITS);
  const [dragging, setDragging] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const previews = useRef<string[]>([]);

  useEffect(() => { api.adhocLimits().then(setLimits).catch(() => {}); }, []);
  // Object URLs for image thumbnails live until the page does.
  useEffect(() => () => { previews.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const meta = (p: Picked) => ({ name: p.file.name, mime: p.mime, size: p.file.size });

  const add = (incoming: File[]) => {
    if (!incoming.length) return;
    const picked = incoming.map((file): Picked => {
      const mime = mimeOf(file.name, file.type);
      return { key: nextKey.current++, file, mime, preview: null };
    });
    // Refuse the whole batch with the reason, rather than silently dropping some of it.
    const problem = newTaskProblem('ok', [...files, ...picked].map(meta), limits);
    if (problem) { setErr(problem); return; }
    for (const p of picked) {
      if (p.mime.startsWith('image/')) { p.preview = URL.createObjectURL(p.file); previews.current.push(p.preview); }
    }
    setErr(null);
    setFiles((cur) => [...cur, ...picked]);
  };
  const remove = (key: number) => setFiles((cur) => cur.filter((p) => p.key !== key));

  // A pasted screenshot arrives as a file on the clipboard; plain text pastes as usual.
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) { e.preventDefault(); add(pasted); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    add(Array.from(e.dataTransfer.files));
  };

  const problem = newTaskProblem(title, files.map(meta), limits);

  const submit = async (choice: 'start' | 'later') => {
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr(null);
    try {
      const payload = await Promise.all(files.map(async (p) => ({ name: p.file.name, mime: p.mime, contentBase64: await toBase64(p.file) })));
      const res = await api.createAdhoc({ title: title.trim(), body, files: payload });
      if (res.status === 201 && res.body.task) navigate(adhocNext(choice, encodeTicketId(res.body.task.id)));
      else setErr(res.body.reason ?? `Couldn’t save the task (${res.status}).`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SetupNotice />
      <Link to="/backlog">← {PAGE.todo}</Link>
      <div className="row between" style={{ margin: '12px 0' }}>
        <h2 style={{ margin: 0 }}>New task</h2>
        <span className="row" style={{ gap: 8 }}>
          <button className="btn ghost" disabled={busy || Boolean(problem)} title={problem ?? `Save it to ${PAGE.todo} and start it later`} onClick={() => submit('later')}>
            {busy ? 'Saving…' : `Add to ${PAGE.todo}`}
          </button>
          <button className="btn" disabled={busy || Boolean(problem)} title={problem ?? 'Save it, then choose the repository and models'} onClick={() => submit('start')}>
            {busy ? 'Saving…' : 'Start now'}
          </button>
        </span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>For work that has no ticket in your tracker. Describe it as you would to a colleague; the planner reads everything here, screenshots included, and you can keep talking it through in the plan chat.</p>

      <div
        className={`card new-task${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        <label className="muted" htmlFor="nt-title">Title</label>
        <input id="nt-title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. The export button does nothing on Safari" style={{ width: '100%', marginBottom: 12 }} autoFocus />

        <label className="muted" htmlFor="nt-body">Description <span className="small">(Markdown)</span></label>
        <textarea id="nt-body" value={body} onChange={(e) => setBody(e.target.value)} rows={16}
          placeholder={'What should change, and why?\n\nSteps to reproduce, what you expected, links, acceptance criteria…\n\nPaste or drop screenshots anywhere on this card.'} />

        <div className="row between" style={{ marginTop: 12 }}>
          <span className="muted small">
            Drop, paste or pick up to {limits.maxFiles} files, {limits.maxFileMb} MB each: images, plain text or PDF.
          </span>
          <button className="btn ghost sm" onClick={() => input.current?.click()} disabled={files.length >= limits.maxFiles}>Add files</button>
          <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,.md,text/csv,application/pdf"
            onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>

        {files.length > 0 && (
          <ul className="attachments">
            {files.map((p) => (
              <li key={p.key} className="attachment">
                {p.preview
                  ? <img src={p.preview} alt={p.file.name} />
                  : <span className="material-symbols-outlined attachment-icon" aria-hidden="true">{p.mime === 'application/pdf' ? 'picture_as_pdf' : 'description'}</span>}
                <span className="attachment-name" title={p.file.name}>{p.file.name}</span>
                <span className="muted small">{formatBytes(p.file.size)}</span>
                <button className="attachment-remove" onClick={() => remove(p.key)} aria-label={`Remove ${p.file.name}`} title="Remove">×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {err && <div className="card" style={{ color: 'var(--bad)' }}>{err}</div>}
    </div>
  );
}
